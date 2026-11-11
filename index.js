// @sadaya/node: Sadaya API client for Node 18 or later, with no dependencies (global fetch and node:crypto).
// Use it only on your server: the API key (sk_live_ or sk_test_) must never reach a browser or a mobile app.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { verifyOrder, SadayaVerificationError } from './verify.js'

export { verifyOrder, depositAddressOf, keccak256, toChecksumAddress, SadayaVerificationError, FACTORIES, NATIVE, MAX_REVIEW_DAYS } from './verify.js'
export const VERSION = '1.0.2'
export const DEFAULT_BASE_URL = 'https://api.sadaya.app'

const USER_AGENT = `sadaya-node/${VERSION.split('.').slice(0, 2).join('.')}`
// sk_live_ or sk_test_ followed by 40 hex characters (the same 24 to 64 range the API accepts is allowed)
const KEY_RE = /^sk_(live|test)_[a-z0-9]{24,64}$/
const SIGNATURE_RE = /^[0-9a-f]{64}$/i

/**
 * An error from the API or from the connection.
 * status: the HTTP status code (0 when there was no response). type: the type the API sent (invalid_request_error,
 * authentication_error, rate_limit_error) or, when it sent none, one set from the status (rate_limit_error,
 * api_error, invalid_request_error), or connection_error.
 * retryAfter: the seconds the response's Retry-After header asks to wait before trying again (a 429 carries it), or
 * null without one.
 * body: the API's response exactly as it came, for debugging.
 */
export class SadayaError extends Error {
  constructor(message, { status = 0, type = 'api_error', body = null, retryAfter = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'SadayaError'
    this.status = status
    this.type = type
    this.retryAfter = retryAfter
    this.body = body
  }
}

/** A webhook signature is invalid or expired: answer 400 and do not process the event. */
export class SadayaSignatureError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SadayaSignatureError'
  }
}

const typeForStatus = status =>
  status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error'

/**
 * The seconds a Retry-After header asks to wait: a whole number of seconds, or an HTTP date (counted from `now`). null
 * when the header is missing or cannot be read.
 */
function retryAfterSeconds(value, now = Date.now()) {
  const v = typeof value === 'string' ? value.trim() : ''
  if (!v) return null
  if (/^\d+$/.test(v)) return Number(v)
  const at = Date.parse(v)
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Number(now)) / 1000))
}

const usageError = message => new SadayaError(message, { type: 'invalid_request_error' })

function pathId(id, what) {
  if (typeof id !== 'string' || !id.trim()) throw usageError(`Missing the ${what} id.`)
  return encodeURIComponent(id.trim())
}

function objectParams(params, what) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw usageError(`Missing the ${what} parameters: pass an object.`)
  return params
}

export class Sadaya {
  #apiKey
  #fetch
  #verify

  /**
   * @param {{ apiKey: string, baseUrl?: string, timeoutMs?: number, fetch?: Function, verify?: object }} options
   * verify: { payout, feeBps | maxFeeBps, feeRecipient?, recovery? }. With this option, every order with an address that
   * the API returns is checked before it reaches you (its address and its payment links are recomputed here, without
   * trusting Sadaya): if they do not match, it throws SadayaVerificationError and you must not show that address. An
   * order with no network chosen yet comes back as it is: it has no address yet.
   */
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, timeoutMs = 20000, fetch: fetchImpl = globalThis.fetch, verify } = {}) {
    const key = typeof apiKey === 'string' ? apiKey.trim() : ''
    if (!KEY_RE.test(key)) {
      throw usageError('Invalid API key: it must start with sk_live_ or sk_test_. Create one in the dashboard (Developers, API keys) and keep it in an environment variable.')
    }
    const base = typeof baseUrl === 'string' ? baseUrl.trim() : ''
    if (!/^https?:\/\/[^\s/?#]+/i.test(base)) throw usageError(`Invalid baseUrl: "${baseUrl}". Use a URL such as ${DEFAULT_BASE_URL}`)
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw usageError('timeoutMs must be a number of milliseconds greater than 0.')
    if (typeof fetchImpl !== 'function') throw usageError('No fetch available: use Node 18 or later, or pass your own function in the fetch option.')
    if (verify !== undefined && (!verify || typeof verify !== 'object' || !/^0x[0-9a-fA-F]{40}$/.test(String(verify.payout || '')))) {
      throw usageError('verify.payout must be your payout wallet (0x and 40 hex characters), taken from your own configuration, never from the API.')
    }
    if (verify && verify.feeBps == null && verify.maxFeeBps == null) {
      throw usageError('verify.feeBps (your agreed fee) or verify.maxFeeBps (the highest fee you accept) is required: without it, the fee each order charges you is not checked.')
    }

    this.#apiKey = key
    this.#fetch = (url, init) => fetchImpl(url, init)
    this.#verify = verify ? Object.freeze({ ...verify }) : null
    this.baseUrl = base.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
    /** true with an sk_live_ key (real money), false with an sk_test_ key (test mode). */
    this.livemode = key.startsWith('sk_live_')

    // with the verify option, no order with an address leaves this client without it checked. An order whose network
    // nobody chose yet has no address (deposit_address and route are null): there is nothing to show, nor to check, and
    // the gateway gives it no payment link either, so a link there is refused like a wrong one
    const checked = order => {
      if (!this.#verify) return order
      if (order?.deposit_address != null) return verifyOrder(order, this.#verify)
      if ((order?.networks || []).some(n => n?.uri != null)) {
        throw new SadayaVerificationError('The order has no address but carries a payment link (uri): do not show it, and let Sadaya know.', 'uri')
      }
      return order
    }
    this.orders = Object.freeze({
      /** Creates an order. With an external_id that already exists, it returns that same order (HTTP 200 instead of 201). */
      create: async params => checked(await this.#request('POST', '/v1/orders', { body: objectParams(params, 'order') })),
      /** An order with its payments. */
      get: async id => checked(await this.#request('GET', `/v1/orders/${pathId(id, 'order')}`)),
      /** Seals the order for a network (its chain_id, such as 56, or its key, such as "bsc") and returns it with its address. Only once. */
      chooseNetwork: async (id, network) => {
        if (network == null || network === '') throw usageError('Missing the network: its chain_id (56) or its key ("bsc").')
        return checked(await this.#request('POST', `/v1/orders/${pathId(id, 'order')}/network`, { body: { network } }))
      },
      /** Orders in the key's mode, newest first: { object, data, has_more }. */
      list: async (params = {}) => {
        const page = await this.#request('GET', '/v1/orders', { query: params })
        if (this.#verify && Array.isArray(page.data)) page.data.forEach(checked)
        return page
      },
      /**
       * Looks at the chain for this order right now, like "Check now" in the dashboard (and under the same limit per account),
       * and returns it with its payments. Live orders only: a test order is paid with the simulate endpoint.
       */
      check: async id => checked(await this.#request('POST', `/v1/orders/${pathId(id, 'order')}/check`, { body: {} })),
      /**
       * Cancels an order that never received anything and returns it, with its payments. Canceling it again returns it as it
       * is; one that already has a payment answers 409.
       */
      cancel: async id => checked(await this.#request('POST', `/v1/orders/${pathId(id, 'order')}/cancel`, { body: {} })),
      /**
       * Accepts an underpaid order as paid with what it received, and returns it with its payments: it becomes paid, received
       * stays what arrived, flags.accepted is set and you get order.paid once. Only while accepting by API is on for your
       * account (the owner turns it on in Developers; otherwise 403). Accepting it again returns it as it is; an order that is
       * not underpaid, or with a payment still confirming or held, answers 409; past the hourly limit, 429.
       */
      accept: async id => checked(await this.#request('POST', `/v1/orders/${pathId(id, 'order')}/accept`, { body: {} })),
    })
    this.settlements = Object.freeze({
      /**
       * Your payouts, newest first, each one exactly as settlement.paid carried it: { object, data, has_more }. For the next
       * page, pass before: the id of the last one. A test key has none.
       */
      list: async (params = {}) => this.#request('GET', '/v1/settlements', { query: params }),
      /** One payout by its id (stl_...): the same data as its settlement.paid. */
      get: async id => this.#request('GET', `/v1/settlements/${pathId(id, 'settlement')}`),
    })
    this.networks = Object.freeze({
      /** Your account's networks, the same in test and live mode: { object, data, has_more }. Offer only these in your own network picker. */
      list: async () => this.#request('GET', '/v1/networks'),
    })
    this.refunds = Object.freeze({
      /** Requests a refund: returns customer_url, the link where the customer leaves the wallet that receives it. */
      create: async params => this.#request('POST', '/v1/refunds', { body: objectParams(params, 'refund') }),
      get: async id => this.#request('GET', `/v1/refunds/${pathId(id, 'refund')}`),
      /** Refunds in the key's mode (up to 100); with { order_id }, only that order's: { object, data }. */
      list: async (params = {}) => this.#request('GET', '/v1/refunds', { query: params }),
      /** Records your refund transaction: Sadaya verifies it on chain and returns the refund. */
      markSent: async (id, { tx_hash } = {}) => {
        if (typeof tx_hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash.trim())) throw usageError('Missing tx_hash: the hash of your transaction (0x and 64 hex characters).')
        return this.#request('POST', `/v1/refunds/${pathId(id, 'refund')}/sent`, { body: { tx_hash: tx_hash.trim() } })
      },
      /** Cancels a refund that has not been sent yet. */
      cancel: async id => this.#request('POST', `/v1/refunds/${pathId(id, 'refund')}/cancel`, { body: {} }),
    })
    this.webhook = Object.freeze({
      get: async () => this.#request('GET', '/v1/webhook'),
      /** Sets the webhook URL. The secret (whsec_...) is only returned when the webhook is created or with rotate_secret: true. */
      set: async ({ url, rotate_secret } = {}) => {
        if (typeof url !== 'string' || !url.trim()) throw usageError('Missing the webhook url (https://...).')
        return this.#request('POST', '/v1/webhook', { body: rotate_secret === undefined ? { url: url.trim() } : { url: url.trim(), rotate_secret } })
      },
    })
  }

  async #request(method, path, { body, query } = {}) {
    const url = new URL(this.baseUrl + path)
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue
      url.searchParams.set(k, v instanceof Date ? v.toISOString() : String(v))
    }
    const headers = { Authorization: `Bearer ${this.#apiKey}`, Accept: 'application/json', 'User-Agent': USER_AGENT }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs)
    let res, text
    try {
      res = await this.#fetch(url.toString(), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal })
      text = await res.text()
    } catch (err) {
      const message = ctl.signal.aborted
        ? `The Sadaya API did not respond within ${this.timeoutMs} ms.`
        : `Could not connect to the Sadaya API: ${err?.message || err}`
      throw new SadayaError(message, { type: 'connection_error', cause: err })
    } finally {
      clearTimeout(timer)
    }

    let data = null
    if (text) {
      try { data = JSON.parse(text) } catch { data = null }
    }
    if (!res.ok) {
      const e = data && typeof data === 'object' ? data.error : null
      const message = (typeof e === 'string' && e) || (e && typeof e.message === 'string' && e.message) || `HTTP ${res.status} error from the Sadaya API.`
      const type = (e && typeof e === 'object' && typeof e.type === 'string' && e.type) || typeForStatus(res.status)
      // a fetch of your own may answer without headers
      const retryAfter = retryAfterSeconds(typeof res.headers?.get === 'function' ? res.headers.get('retry-after') : null)
      throw new SadayaError(message, { status: res.status, type, body: data ?? text ?? null, retryAfter })
    }
    if (!data || typeof data !== 'object') {
      throw new SadayaError('The Sadaya API returned a response that is not JSON.', { status: res.status, type: 'api_error', body: text ?? null })
    }
    return data
  }
}

function toBuffer(raw) {
  if (typeof raw === 'string') return Buffer.from(raw, 'utf8')
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof Uint8Array) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  if (raw instanceof ArrayBuffer) return Buffer.from(raw)
  return null
}

/**
 * Verifies a webhook and returns the parsed event.
 * rawBody: the raw body exactly as it arrived (string, Buffer or Uint8Array), never the already parsed object.
 * signatureHeader: the X-Sadaya-Signature header ("t=<seconds>,v1=<hex>").
 * secret: the full webhook secret, with its whsec_ prefix.
 * Throws SadayaSignatureError if the signature does not match or was made more than toleranceSec seconds ago.
 */
export function verifyWebhook(rawBody, signatureHeader, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (typeof secret !== 'string' || !secret) {
    throw new SadayaSignatureError('Missing the webhook secret (whsec_...): copy it from the dashboard or from the POST /v1/webhook response.')
  }
  const bytes = toBuffer(rawBody)
  if (!bytes) {
    throw new SadayaSignatureError('Pass the raw webhook body (string, Buffer or Uint8Array) exactly as it arrived, without parsing it. In Express, use express.raw({ type: \'application/json\' }) on that route.')
  }

  const header = Array.isArray(signatureHeader) ? signatureHeader.join(',') : String(signatureHeader ?? '')
  let t = null
  const signatures = []
  for (const part of header.split(',')) {
    const i = part.indexOf('=')
    if (i < 1) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k === 't' && /^\d{1,12}$/.test(v)) t = v
    else if (k === 'v1' && SIGNATURE_RE.test(v)) signatures.push(Buffer.from(v, 'hex'))
  }
  if (t === null || !signatures.length) {
    throw new SadayaSignatureError('The X-Sadaya-Signature header is missing or does not have the format t=<seconds>,v1=<signature>.')
  }

  // HMAC-SHA256 with the secret over "<t>.<raw body>", compared in constant time
  const expected = createHmac('sha256', secret).update(`${t}.`).update(bytes).digest()
  if (!signatures.some(sig => timingSafeEqual(sig, expected))) {
    throw new SadayaSignatureError('The signature does not match: check the webhook secret and that you pass the raw body, neither parsed nor reformatted.')
  }

  const age = Math.abs(Math.floor(Number(now) / 1000) - Number(t))
  if (!(age <= toleranceSec)) {
    throw new SadayaSignatureError(`The signature has expired: it is ${age} s away from your clock (at most ${toleranceSec} s). If this keeps happening, check your server's clock.`)
  }

  let event
  try { event = JSON.parse(bytes.toString('utf8')) } catch { event = null }
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new SadayaSignatureError('The webhook body is not a valid JSON object.')
  }
  return event
}

export default Sadaya
