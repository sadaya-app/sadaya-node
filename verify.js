// Verifies an order's address without trusting Sadaya.
//
// Every order is paid to an address that is a contract: CREATE2 from the official factory, with the route sealed
// inside (your payout wallet, the fee, the `handler` address, what the order accepts and, since factory v3, who splits
// the order during the review window and until when). This library recomputes that address with the same formula as
// the contract, and checks that the route pays you and that every payment link (uri) pays that address. An address, a
// route or a link that does not match fails verification, and your store never shows it to the customer.
//
// An order on Tron is paid straight into your own Tron wallet, so there is no contract address there: it must pay
// exactly the Tron wallet you configured, take only USDT on Tron, at your fee, and offer no payment link.
//
// An order on Bitcoin is paid straight into your own wallet too, at an address of its own: the one your extended public
// key (the zpub or xpub you gave Sadaya) derives at the index its route carries. This library derives it again from your
// key (bitcoin.js) and checks that it is the order's, that it takes only BTC, at your fee, and that its payment link pays it.
//
// No dependencies and no Node APIs: it runs the same on Node 18+, Cloudflare Workers and browsers.

import { BTC_ID, LTC_ID, bitcoinAddress, bitcoinKeyId, litecoinAddress, litecoinKeyId } from './bitcoin.js'
export { BTC_ID, LTC_ID, bitcoinAddress, bitcoinKeyId, litecoinAddress, litecoinKeyId } from './bitcoin.js'

/**
 * Sadaya's official factories (the same address on every EVM network), the logic contract of their clones and their
 * version: v3 and v4 seal a review window, v2 sealed the earlier orders. Each remains valid for its own orders.
 */
export const FACTORIES = Object.freeze({
  '0xee202bdc2108e2622a22c2ae61764239dc6c3ff4': Object.freeze({ implementation: '0x9dc74a33708e80e7d9c0eb91baf53f88ac755b8d', version: 4 }),
  '0xcde84310ea54757b3e965897c49358d598e31404': Object.freeze({ implementation: '0x8fff0825226a4024fe23ae6155db250d25f13cee', version: 3 }),
  '0xa6edd5ef5356cdb84b42f25c324773e27a745b80': Object.freeze({ implementation: '0xcc1ee2ca2873ed730087b65f30b34335302bc1a4', version: 2 }),
})
/**
 * The tokens that are not dollars, by network (lowercase): a coin as a token of another network (ETH on BNB Chain) and the
 * wrapped coins. A deposit's route may take one of them, or the network's own coin, only if the order lists it in `networks`;
 * the dollar stablecoins it takes one to one need not be listed. A token missing here is taken for a dollar.
 */
const COIN_TOKENS = Object.freeze({
  1: Object.freeze(['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599']),
  56: Object.freeze(['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', '0x2170ed0880ac9a755fd29b2688956bd959f933f8']),
})
/** The longest review window verifyOrder accepts unless you pass another one, in days. */
export const MAX_REVIEW_DAYS = 31
/** The network's native coin (ETH, BNB) in the accepted list. */
export const NATIVE = '0x0000000000000000000000000000000000000000'
/**
 * Tron, a direct network: the customer pays straight into your own Tron wallet (T...), so there is no contract address to
 * recompute. Its orders take only USDT on Tron (TRC-20).
 */
export const TRON = Object.freeze({ chain_id: 728126428, usdt: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' })
/** A Tron address as people write it: T and 33 characters of base58 (base58 is case-sensitive: compared exactly). */
const isTron = a => typeof a === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)

/** The order failed verification: do not show its address. `check` says what failed. */
export class SadayaVerificationError extends Error {
  constructor(message, check) {
    super(message)
    this.name = 'SadayaVerificationError'
    /** route | payout | tron_wallet | bitcoin_key | litecoin_key | fee | fee_recipient | handler | review | networks | address | uri | network */
    this.check = check
  }
}

/* ───────── Keccak-256: Ethereum's hash (not the standard SHA3-256) ───────── */

const MASK = (1n << 64n) - 1n
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]
// rotation of each lane, in x + 5y order
const ROT = [0n, 1n, 62n, 28n, 27n, 36n, 44n, 6n, 55n, 20n, 3n, 10n, 43n, 25n, 39n, 41n, 45n, 15n, 21n, 8n, 18n, 2n, 61n, 56n, 14n]
const rotl = (v, n) => (n === 0n ? v : ((v << n) | (v >> (64n - n))) & MASK)

function keccakF(A) {
  const C = new Array(5), B = new Array(25)
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]
    for (let x = 0; x < 5; x++) {
      const d = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n)
      for (let y = 0; y < 25; y += 5) A[x + y] ^= d
    }
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y])
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] = B[x + 5 * y] ^ ((MASK ^ B[((x + 1) % 5) + 5 * y]) & B[((x + 2) % 5) + 5 * y])
    A[0] ^= RC[round]
  }
}

/** Keccak-256 of some bytes (Uint8Array); returns 32 bytes. */
export function keccak256(data) {
  const rate = 136, A = new Array(25).fill(0n)
  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate)
  padded.set(data)
  padded[data.length] ^= 0x01
  padded[padded.length - 1] ^= 0x80
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b])
      A[i] ^= lane
    }
    keccakF(A)
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 4; i++) {
    let lane = A[i]
    for (let b = 0; b < 8; b++) { out[i * 8 + b] = Number(lane & 0xffn); lane >>= 8n }
  }
  return out
}

/* ───────── bytes ───────── */

const isAddress = a => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)
const fromHex = h => { const s = h.replace(/^0x/, ''); const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return out }
const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
const concat = parts => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length } return out }
/** An unsigned number as a 32-byte word (big-endian), like abi.encode. */
const word = n => { const out = new Uint8Array(32); let v = BigInt(n); for (let i = 31; i >= 0 && v > 0n; i--) { out[i] = Number(v & 0xffn); v >>= 8n } return out }
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

/** The address with its checksum capitals (EIP-55), as wallets show it. */
export function toChecksumAddress(address) {
  const a = address.toLowerCase().replace(/^0x/, '')
  const h = toHex(keccak256(new TextEncoder().encode(a)))
  return `0x${[...a].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('')}`
}

/* ───────── the contract's formula ───────── */

/** The order's on-chain id: its UUID as bytes32 (left-padded). */
export function orderIdOf(uuid) {
  const h = String(uuid).toLowerCase().replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/.test(h)) throw new SadayaVerificationError(`Invalid order id: ${uuid}`, 'route')
  return concat([new Uint8Array(16), fromHex(h)])
}

/** keccak256(abi.encode(Accepted[])) with Accepted = (uint64 chainId, address token), in the route's order. */
export function acceptedHash(accepted) {
  const parts = [word(32), word(accepted.length)]
  for (const a of accepted) parts.push(word(a.chain_id), concat([new Uint8Array(12), fromHex(a.token)]))
  return keccak256(concat(parts))
}

/**
 * What the factory seals into each clone: merchant, fee wallet, fee, `handler` address and the accepted list (94 bytes,
 * factory v2) and, in v3 and v4, who splits the order during the review window and when that window ends (119 bytes).
 */
export function routeArgs(route, version = route.open_after != null ? 3 : 2) {
  const fee = Number(route.fee_bps)
  const v2 = [fromHex(route.merchant), fromHex(route.fee_recipient), new Uint8Array([fee >> 8, fee & 0xff]), fromHex(route.handler), acceptedHash(route.accepted)]
  if (version < 3) return concat(v2)
  const end = new Uint8Array(5) // uint40, big-endian
  let t = BigInt(route.open_after)
  for (let i = 4; i >= 0; i--) { end[i] = Number(t & 0xffn); t >>= 8n }
  return concat([...v2, fromHex(route.settler), end])
}

/** An order's deposit address: CREATE2(factory, order id, clone with the route as its arguments). */
export function depositAddressOf(order) {
  const route = order?.route, key = String(route?.factory).toLowerCase()
  const f = route && Object.hasOwn(FACTORIES, key) ? FACTORIES[key] : null
  if (!f) throw new SadayaVerificationError('The order does not carry a route with an official factory: update the library or let Sadaya know.', 'route')
  if ((f.version >= 3) !== (route.open_after != null)) throw new SadayaVerificationError('The order\'s route does not match its factory: do not show its address, and let Sadaya know.', 'route')
  const implementation = f.implementation
  const args = routeArgs(route, f.version)
  const len = args.length + 0x2d
  // OpenZeppelin Clones._cloneCodeWithImmutableArgs, byte for byte
  const initCode = concat([new Uint8Array([0x61, len >> 8, len & 0xff]), fromHex('3d81600a3d39f3363d3d373d3d3d363d73'), fromHex(implementation), fromHex('5af43d82803e903d91602b57fd5bf3'), args])
  const hash = keccak256(concat([new Uint8Array([0xff]), fromHex(route.factory), orderIdOf(order.id), keccak256(initCode)]))
  return toChecksumAddress(`0x${toHex(hash.slice(12))}`)
}

/** A wallet the contract accepts: any address except the zero address (with that one, nothing ever leaves). */
const isWallet = a => isAddress(a) && !/^0x0{40}$/i.test(a)

function checkRoute(route) {
  const ok = route && isWallet(route.merchant) && isWallet(route.fee_recipient) && isWallet(route.handler) && isAddress(route.factory)
    && Number.isInteger(route.fee_bps) && route.fee_bps >= 0 && route.fee_bps <= 1000
    && Array.isArray(route.accepted) && route.accepted.length > 0 && route.accepted.length <= 64
    // a network id the contract can read (uint64) and that a JavaScript number holds exactly
    && route.accepted.every(a => Number.isSafeInteger(a?.chain_id) && a.chain_id > 0 && isAddress(a.token))
    // factories v3 and v4: who splits during the window (never the zero address) and when it ends (unix seconds, uint40)
    && (route.open_after == null || (isWallet(route.settler) && Number.isInteger(route.open_after) && route.open_after >= 0 && route.open_after < 2 ** 40))
  if (!ok) throw new SadayaVerificationError('The order does not carry its complete route (route): do not show its address, and let Sadaya know.', 'route')
}

// a payment link (EIP-681) exactly as the gateway builds it: the token's transfer to the address, or the network's coin
// sent to it, for what is still due (due_units)
const TOKEN_URI = /^ethereum:(0x[0-9a-fA-F]{40})@(\d+)\/transfer\?address=(0x[0-9a-fA-F]{40})&uint256=(\d+)$/
const NATIVE_URI = /^ethereum:(0x[0-9a-fA-F]{40})@(\d+)\?value=(\d+)$/

/** Whether a network's payment link pays `address` that token on that chain for its due_units (hex compared without case). */
function uriPays(n, address) {
  if (typeof n.uri !== 'string') return false
  const chain = String(n.chain_id), units = String(n.due_units)
  if (!n.token || same(n.token, NATIVE)) {
    const m = NATIVE_URI.exec(n.uri)
    return !!m && same(m[1], address) && m[2] === chain && m[3] === units
  }
  const m = TOKEN_URI.exec(n.uri)
  return !!m && same(m[1], n.token) && m[2] === chain && same(m[3], address) && m[4] === units
}

/** The fee a route charges you: exactly the agreed one (feeBps) or at most the highest you accept (maxFeeBps). One is required. */
function checkFee(route, expected) {
  if (expected.feeBps == null && expected.maxFeeBps == null) {
    throw new SadayaVerificationError('Missing your agreed fee (feeBps) or the highest fee you accept (maxFeeBps): without it, the fee the order charges you cannot be checked.', 'fee')
  }
  if (expected.feeBps != null && route.fee_bps !== Number(expected.feeBps)) {
    throw new SadayaVerificationError(`The order's fee (${route.fee_bps} basis points) is not the agreed one (${expected.feeBps}).`, 'fee')
  }
  if (expected.maxFeeBps != null && route.fee_bps > Number(expected.maxFeeBps)) {
    throw new SadayaVerificationError(`The order's fee (${route.fee_bps} basis points) exceeds the maximum you accept (${expected.maxFeeBps}).`, 'fee')
  }
}

/**
 * An order on Tron: the customer pays straight into your own Tron wallet, with an exact amount whose 3rd and 4th decimals
 * tell the payment apart. There is no contract: it must pay exactly the Tron wallet you configured (tronWallet), take only
 * USDT on Tron, at your fee, and offer no payment link (Tron has no standard one: show the address and the exact amount).
 */
function verifyDirect(order, expected) {
  if (!isTron(expected.tronWallet)) {
    throw new SadayaVerificationError('Missing your Tron wallet (tronWallet) to verify an order on Tron: set it in your configuration, never take it from the API.', 'tron_wallet')
  }
  const route = order.route
  const ok = route.direct === 'tron' && isTron(route.merchant) && Number.isInteger(route.fee_bps) && route.fee_bps >= 0 && route.fee_bps <= 1000
    && Array.isArray(route.accepted) && route.accepted.length === 1 && route.accepted[0]?.chain_id === TRON.chain_id && route.accepted[0]?.token === TRON.usdt
  if (!ok) throw new SadayaVerificationError('The order does not carry its complete route (route): do not show its address, and let Sadaya know.', 'route')
  if (route.merchant !== expected.tronWallet) {
    throw new SadayaVerificationError(`The order does not pay your Tron wallet (it pays ${route.merchant}): do not show its address, and let Sadaya know.`, 'tron_wallet')
  }
  checkFee(route, expected)
  if (order.deposit_address !== route.merchant) {
    throw new SadayaVerificationError('The order\'s address is not your Tron wallet: do not show it to the customer, and let Sadaya know.', 'address')
  }
  for (const n of order.networks || []) {
    if (Number(n.chain_id) !== TRON.chain_id || n.token !== TRON.usdt) {
      throw new SadayaVerificationError(`The order offers payment in ${n.symbol || n.token} on network ${n.chain_id}, which its route does not accept.`, 'networks')
    }
    if (n.uri != null) {
      throw new SadayaVerificationError(`The payment link for ${n.symbol || 'the order'} on network ${n.chain_id} does not pay the order's address: do not show it, and let Sadaya know.`, 'uri')
    }
  }
  return order
}

// the networks of their own coin, by route.direct: each one's id, its option and check, its kinds of key, its addresses (native
// SegWit, the only kind the gateway derives: the prefix and 38 characters of bech32), its payment link exactly as the gateway
// builds it (BIP21: the address and what is still due, in its coin) and its derivation
const B32 = '[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}'
const UTXO = {
  bitcoin: { id: BTC_ID, name: 'Bitcoin', option: 'bitcoinKey', check: 'bitcoin_key', kinds: 'zpub or xpub', address: new RegExp(`^bc1q${B32}$`),
    uri: new RegExp(`^bitcoin:(bc1q${B32})\\?amount=(\\d+)(?:\\.(\\d{1,8}))?$`), derive: bitcoinAddress, keyId: bitcoinKeyId },
  litecoin: { id: LTC_ID, name: 'Litecoin', option: 'litecoinKey', check: 'litecoin_key', kinds: 'zpub or Ltub', address: new RegExp(`^ltc1q${B32}$`),
    uri: new RegExp(`^litecoin:(ltc1q${B32})\\?amount=(\\d+)(?:\\.(\\d{1,8}))?$`), derive: litecoinAddress, keyId: litecoinKeyId },
}

/**
 * An order on Bitcoin or Litecoin: the customer pays straight into your own wallet, at the address your extended public key
 * (bitcoinKey or litecoinKey: the one you gave Sadaya for that network) derives at the route's index, on branch 0 (receive) for
 * a live order and 1 (change) for a test one. There is no contract: the address is derived here again from your key, and it
 * must be the route's and the order's; the route must come from your key (key_id) and take only its coin, at your fee; and
 * each payment link must pay that address for what is still due (due_units, in the coin's smallest unit).
 */
function verifyUtxo(order, expected, n) {
  const key = expected[n.option], keyId = n.keyId(key)
  if (!keyId) {
    throw new SadayaVerificationError(`Missing your ${n.name} public key (${n.option}: the ${n.kinds} you gave Sadaya) to verify an order on ${n.name}: set it in your configuration, never take it from the API.`, n.check)
  }
  const route = order.route
  const ok = typeof route.merchant === 'string' && n.address.test(route.merchant) && Number.isInteger(route.fee_bps) && route.fee_bps >= 0 && route.fee_bps <= 1000
    && Array.isArray(route.accepted) && route.accepted.length === 1 && route.accepted[0]?.chain_id === n.id && route.accepted[0]?.token == null
    && typeof route.key_id === 'string' && (route.branch === 0 || route.branch === 1) && Number.isInteger(route.index) && route.index >= 0 && route.index < 2 ** 31
    // a live order receives on branch 0, a test one on branch 1
    && (typeof order.livemode !== 'boolean' || route.branch === (order.livemode ? 0 : 1))
  if (!ok) throw new SadayaVerificationError('The order does not carry its complete route (route): do not show its address, and let Sadaya know.', 'route')
  if (route.key_id !== keyId) {
    throw new SadayaVerificationError(`The order's address does not come from your ${n.name} key (it comes from key ${route.key_id}): do not show it, and let Sadaya know.`, n.check)
  }
  checkFee(route, expected)
  const address = n.derive(key, route.index, route.branch)
  if (route.merchant !== address || order.deposit_address !== address) {
    throw new SadayaVerificationError(`The order's address is not the one your ${n.name} key gives at its index: do not show it to the customer, and let Sadaya know.`, 'address')
  }
  for (const x of order.networks || []) {
    if (Number(x.chain_id) !== n.id || x.token != null) {
      throw new SadayaVerificationError(`The order offers payment in ${x.symbol || x.token} on network ${x.chain_id}, which its route does not accept.`, 'networks')
    }
    if (x.uri == null) continue
    const m = n.uri.exec(x.uri)
    const units = m ? BigInt(m[2]) * 100000000n + BigInt((m[3] || '').padEnd(8, '0')) : null
    if (!m || m[1] !== address || !/^\d+$/.test(String(x.due_units)) || units !== BigInt(x.due_units)) {
      throw new SadayaVerificationError(`The payment link for ${x.symbol || 'the order'} on network ${x.chain_id} does not pay the order's address: do not show it, and let Sadaya know.`, 'uri')
    }
  }
  return order
}

/**
 * Checks an order before its address is shown to the customer. Returns the order or throws SadayaVerificationError.
 * Besides the route and the address, it checks that each network's uri (when there is one) pays that address, with
 * that token, on that network and for what is still due (due_units), exactly as Sadaya builds it. An order with no
 * chosen network has no address: it throws check 'network'. A deposit whose route takes a coin its `networks` does not
 * list throws check 'networks'.
 * An order on Tron (route.direct 'tron') is checked against your own Tron wallet instead (tronWallet), and one on Bitcoin or
 * Litecoin (route.direct 'bitcoin', 'litecoin') against your extended public key there (bitcoinKey, litecoinKey): there is no
 * contract.
 * expected: what your store knows on its own, never what the API says.
 *   payout        your payout wallet (required for the orders of the EVM networks)
 *   tronWallet    your own Tron wallet, T... (required for the orders on Tron)
 *   bitcoinKey    the extended public key you gave Sadaya for Bitcoin, zpub or xpub (required for the orders on Bitcoin)
 *   litecoinKey   the extended public key you gave Sadaya for Litecoin, zpub or Ltub (required for the orders on Litecoin)
 *   feeBps        your agreed fee in basis points (100 = 1%), exact; or maxFeeBps, the highest fee you accept (always
 *                 one of the two: without it, a route that charges you 10% would pass)
 *   feeRecipient  Sadaya's fee wallet, if you want to pin it
 *   handler       the route's handler address, if you want to pin it
 *   maxReviewDays the longest review window you accept, in days (MAX_REVIEW_DAYS, 31, by default): until it ends only
 *                 Sadaya can split the order
 *   now           the moment of the check, in milliseconds (now, by default)
 */
export function verifyOrder(order, expected = {}) {
  // an order on a direct network pays your own wallet, with no contract address: Bitcoin's and Litecoin's are checked against
  // your key there (bitcoinKey, litecoinKey), Tron's against tronWallet
  const direct = order?.route?.direct
  if (typeof direct === 'string' && Object.hasOwn(UTXO, direct)) return verifyUtxo(order, expected, UTXO[direct])
  if (order?.route?.direct != null) return verifyDirect(order, expected)
  if (!isAddress(expected.payout)) throw new SadayaVerificationError('Missing your payout wallet (payout) to verify the order: set it in your configuration, never take it from the API.', 'payout')
  // with no chosen network, the order has no address or route yet: there is nothing to show, nor to verify
  if (order && order.deposit_address == null && order.route == null) {
    throw new SadayaVerificationError('The order has no chosen network yet, so it has no address: verify it once it has one.', 'network')
  }
  const route = order?.route
  checkRoute(route)
  if (!same(route.merchant, expected.payout)) {
    throw new SadayaVerificationError(`The order does not pay your payout wallet (it pays ${route.merchant}): do not show its address, and let Sadaya know.`, 'payout')
  }
  checkFee(route, expected)
  if (expected.feeRecipient && !same(route.fee_recipient, expected.feeRecipient)) {
    throw new SadayaVerificationError('The order\'s fee wallet is not the one you pinned.', 'fee_recipient')
  }
  if (expected.handler && !same(route.handler, expected.handler)) {
    throw new SadayaVerificationError('The order\'s handler address is not the one you pinned.', 'handler')
  }
  // factories v3 and v4: the window in which only Sadaya can split the order cannot be longer than the one you accept
  if (route.open_after != null) {
    const days = Number(expected.maxReviewDays ?? MAX_REVIEW_DAYS), nowS = Math.floor(Number(expected.now ?? Date.now()) / 1000)
    if (route.open_after > nowS + days * 86400) {
      throw new SadayaVerificationError(`The order's review window (until ${new Date(route.open_after * 1000).toISOString().slice(0, 10)}) is longer than the one you accept (${days} days).`, 'review')
    }
  }
  // whatever the checkout asks the customer to pay must be in the accepted list: only that is split, and only to your wallet
  for (const n of order.networks || []) {
    const token = n.token || NATIVE
    if (!route.accepted.some(a => a.chain_id === Number(n.chain_id) && same(a.token, token))) {
      throw new SadayaVerificationError(`The order offers payment in ${n.symbol || token} on network ${n.chain_id}, which its route does not accept.`, 'networks')
    }
  }
  // a deposit credits whatever arrives: its route may take a coin (the network's own, or a token that is not a dollar) only
  // if the order lists it, so your store always knows what it can be credited in at a price
  if (order.mode === 'deposit') {
    for (const a of route.accepted) {
      const coin = same(a.token, NATIVE) || (Object.hasOwn(COIN_TOKENS, a.chain_id) && COIN_TOKENS[a.chain_id].includes(a.token.toLowerCase()))
      if (coin && !(order.networks || []).some(n => Number(n.chain_id) === a.chain_id && same(n.token || NATIVE, a.token))) {
        throw new SadayaVerificationError(`The deposit's route takes a coin on network ${a.chain_id} (${a.token}) that the order does not list: do not show its address, and let Sadaya know.`, 'networks')
      }
    }
  }
  if (!same(depositAddressOf(order), order.deposit_address)) {
    throw new SadayaVerificationError('The order\'s address does not match its route: do not show it to the customer, and let Sadaya know.', 'address')
  }
  // each payment link must pay the address just verified, so a QR made from it is safe to show; a null uri is no link
  for (const n of order.networks || []) {
    if (n.uri != null && !uriPays(n, order.deposit_address)) {
      throw new SadayaVerificationError(`The payment link for ${n.symbol || 'the order'} on network ${n.chain_id} does not pay the order's address: do not show it, and let Sadaya know.`, 'uri')
    }
  }
  return order
}
