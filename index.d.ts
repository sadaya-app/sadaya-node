// Types for @sadaya/node (Sadaya API v1).

import type { Route, VerifyExpected } from './verify.js'
export * from './verify.js'

export declare const VERSION: string
/** https://api.sadaya.app */
export declare const DEFAULT_BASE_URL: string

/* ───────── values ───────── */

/**
 * USD = a price in dollars: paid with USDT or USDC one to one, or with ETH or BNB at a rate fixed when the order is created.
 * ETH also pays on BNB Chain, as its BEP-20 token: one to one in an ETH order, at its own fixed rate in a USD order.
 */
export type Currency = 'USDT' | 'USDC' | 'ETH' | 'BNB' | 'POL' | 'USD'
/** canceled: you canceled it before it received anything (orders.cancel); what arrives anyway moves it on, as a late payment. */
export type OrderStatus = 'pending' | 'confirming' | 'underpaid' | 'paid' | 'expired' | 'canceled'
/** The statuses a merchant sees: anything that arrived on another network or in another coin never shows up here. */
export type PaymentStatus = 'seen' | 'confirmed' | 'settled' | 'held' | 'reorged' | 'ignored'
export type RefundStatus = 'requested' | 'address_received' | 'sent' | 'completed' | 'cancelled'
/**
 * The API sends the first three. When a response carries no type, the SDK sets one from the HTTP status; with no
 * response at all, connection_error.
 */
export type ErrorType = 'invalid_request_error' | 'authentication_error' | 'rate_limit_error' | 'api_error' | 'connection_error'

/* ───────── objects ───────── */

/** One way to pay the order: a network and a coin. */
export interface Network {
  /** 1 = Ethereum, 56 = BNB Chain. */
  chain_id: number
  name: string
  /** What is paid on that network: USDT, USDC, ETH, BNB, POL. On BNB Chain, ETH is paid as its BEP-20 token. */
  symbol: string
  /** The coin's own name on that network, to show it: 'ETH (BEP-20)' for ETH on BNB Chain; otherwise the same as symbol. */
  label?: string
  /** The token contract, or null for the network's native coin. */
  token: string | null
  /** The token's decimals on that network (USDT: 6 on Ethereum, 18 on BNB Chain). */
  decimals: number
  /** true when paid with the network's own coin (ETH, BNB). ETH on BNB Chain is a token: false, with its token. */
  native: boolean
  /** The order's total in this coin, as a decimal string. On a guide (guide: true), the dollars announced at the price of now. */
  amount: string
  /** The exact amount in base units (integer string). */
  amount_units: string
  /** What is still due in this coin (equal to amount until a partial payment). */
  due: string
  /** The same, in base units. */
  due_units: string
  /** Blocks to wait before the payment counts as confirmed. */
  confirmations: number
  /** The network's block explorer, for example https://etherscan.io */
  explorer: string | null
  /**
   * EIP-681 payment link for what is still due (due_units): put it in a QR code or a button. null until the network is
   * chosen. With the verify option, the library checks that it pays deposit_address.
   */
  uri: string | null
  /**
   * USD orders only, on the coins paid at a price (ETH, BNB, and ETH on BNB Chain): in a charge, the dollar price fixed when
   * the order was created; in a deposit (guide: true), the price of now, only a guide.
   */
  price_usd?: string
  /**
   * true on a coin of a USD deposit: its price_usd and its amounts are those of now, a guide for the dollars announced. What
   * arrives is credited at the coin's price when it arrives (each payment's price_usd and value).
   */
  guide?: boolean
}

export interface OrderFlags {
  /** More than the requested amount arrived (past your tolerance). Each later payment to a paid charge sends order.overpaid. */
  overpaid?: boolean
  /** A payment arrived after expires_at. */
  late?: boolean
  /** A payment is held for review: the order stays in confirming until Sadaya decides. */
  held?: boolean
  /** A reviewed payment was frozen at the order's address and is not split. */
  frozen?: boolean
  /** A payment came from a sanctioned address and was held. */
  sanctioned?: boolean
  /** You accepted it as paid with less than its amount (orders.accept, or in the dashboard). */
  accepted?: boolean
}

export interface Customer {
  email: string | null
  name: string | null
}

export interface Order {
  /** UUID. */
  id: string
  object: 'order'
  livemode: boolean
  merchant_id: string
  external_id: string | null
  description: string | null
  status: OrderStatus
  currency: Currency
  /** Requested amount, as a decimal string ("15.00"). */
  amount: string
  /** Received and confirmed, in the order's currency. */
  received: string
  /** Seen on chain (confirmed or not), in the order's currency. */
  seen: string
  /** charge: charges amount. deposit: credits whatever arrives (order.credited). */
  mode: 'charge' | 'deposit'
  /**
   * The chosen network (chain_id), or null while nobody has chosen it. It is also null on an order created before
   * network selection existed, which does have an address (valid on all its networks): to know whether there is an
   * address, look at deposit_address.
   */
  network: number | null
  /** The order's address (0x...), sealed for network only. null until the network is chosen: there is nothing to show. */
  deposit_address: string | null
  /** The route sealed into that address: with it, your library recomputes the address (verifyOrder). null with no chosen network. */
  route: Route | null
  networks: Network[]
  flags: OrderFlags
  customer: Customer | null
  /** The payment link that created the order, if it came from one. */
  product_id: string | null
  /** USD orders only: the fixed price of the native coin, by network ({ "56": { symbol: "BNB", price_usd, amount } }). */
  quote: Record<string, { symbol: string; price_usd: string; amount: string }> | null
  /** The hosted payment page: send the customer here. */
  checkout_url: string
  redirect_url: string | null
  metadata: Record<string, unknown> | null
  /** When it expires if it is not paid. Canceling an order that had not expired moves it to the moment it was canceled. */
  expires_at: string
  paid_at: string | null
  settled_at: string | null
  /** When you canceled it, or null. It stays after money that arrives anyway moves its status on. */
  canceled_at: string | null
  /** When you accepted it as paid with less than its amount, or null. */
  accepted_at: string | null
  /** How you accepted it: by API or in the dashboard; null if you did not. */
  accepted_by: 'api' | 'dashboard' | null
  created_at: string
}

export interface Payment {
  chain_id: number
  symbol: string | null
  /** Base units (integer string). */
  amount_units: string
  decimals: number
  /** The payment's transaction: null for a simulated payment and for one in the network's own coin (ETH, BNB), which Sadaya detects from the address's balance. */
  tx_hash: string | null
  /** Who paid: null for a payment in the network's own coin (ETH, BNB). */
  from_addr: string | null
  status: PaymentStatus
  /** 1 if it arrived after expires_at. */
  late: 0 | 1
  /** The transaction that split it to your wallet. */
  settled_tx: string | null
  /** amount_units as a decimal string. */
  amount?: string | null
  /**
   * A coin in a USD order: the dollar price it counts at (a charge's fixed rate, or the lower one if it arrived late; in a
   * deposit, its price when it arrived). null for a dollar stablecoin, an order in a coin, or while its price is not known.
   */
  price_usd?: string | null
  /** What it counts for in the order's currency: in a USD deposit, the dollars credited. null while its price is not known. */
  value?: string | null
}

/** What GET /v1/orders/{id} returns. */
export interface OrderWithPayments extends Order {
  payments: Payment[]
  /** The order's refunds, oldest first. */
  refunds: Refund[]
}

export interface List<T> {
  object: 'list'
  data: T[]
  has_more: boolean
}

export interface Refund {
  /** rfd_... */
  id: string
  object: 'refund'
  order_id: string
  status: RefundStatus
  /** Decimal string, in the coin the order was paid with. */
  amount: string
  symbol: string
  chain_id: number
  network: string
  /** Link for the customer: where they leave the wallet that receives the refund. */
  customer_url: string
  /** The customer's wallet, once they have left it. */
  address: string | null
  /** Your refund transaction, once you record it (dashboard or refunds.markSent). */
  tx_hash: string | null
  reason: string | null
  /** Why the last recorded transaction was not accepted. */
  error: string | null
  livemode: boolean
  created_at: string
  /** When the customer entered their wallet. */
  address_at: string | null
  sent_at: string | null
  completed_at: string | null
  /** Until when the customer's link works. */
  expires_at: string | null
}

export interface RefundListParams {
  order_id?: string
}

export interface WebhookEndpoint {
  object: 'webhook'
  url: string | null
  secret_set: boolean
  /** whsec_...: only returned when the webhook is created or with rotate_secret: true. Store it; it is not shown again. */
  secret?: string
}

export interface SettlementTotal {
  token: string
  symbol: string | null
  gross: string
  fee: string
  net: string
}

export interface SettlementOrder {
  id: string
  external_id: string | null
  symbol: string | null
  amount: string
  fee: string
  net: string
}

/**
 * The data of settlement.paid: one transaction that split several orders on one network. settlements.list and
 * settlements.get answer exactly this.
 */
export interface Settlement {
  object: 'settlement'
  /** An opaque identifier, the same on retries. */
  id: string
  merchant_id: string
  livemode?: boolean
  /** schedule (your schedule), instant or manual ("settle now"). */
  kind: 'schedule' | 'instant' | 'manual' | (string & {})
  chain_id: number
  network: string
  tx_hash: string
  totals: SettlementTotal[]
  orders: SettlementOrder[]
}

/** The data of the order.* events: the order, plus a detail in some of them. */
export interface OrderEventData extends Order {
  /**
   * order.settled: the transaction that split the order (amounts in base units). If the split was not sent by Sadaya,
   * id is null and external is true.
   */
  settlement?: { id: string | null; chain_id: number; tx_hash: string; splits: Array<{ token: string; amount: string; fee: string }>; external?: boolean }
}

/* ───────── webhooks ───────── */

export type OrderEventType =
  | 'order.confirming'
  | 'order.paid'
  | 'order.underpaid'
  | 'order.expired'
  | 'order.pending'
  | 'order.late_payment'
  | 'order.credited'
  /** A charge that was already paid received more: received is the new total. */
  | 'order.overpaid'
  /** You canceled the order (by API or in the dashboard). */
  | 'order.canceled'
  | 'order.settled'
export type RefundEventType = 'refund.address_received' | 'refund.completed'
export type WebhookEventType = OrderEventType | 'settlement.paid' | RefundEventType | 'test'

interface EventBase<T extends string, D> {
  /** evt_...: use it to avoid processing the same event twice. */
  id: string
  type: T
  created_at: string
  /** false in test mode. */
  livemode: boolean
  data: D
}
export type OrderEvent = EventBase<OrderEventType, OrderEventData>
export type SettlementEvent = EventBase<'settlement.paid', Settlement>
/** A refund event's data is the refund, with the merchant it belongs to. */
export type RefundEvent = EventBase<RefundEventType, Refund & { merchant_id: string }>
/** The dashboard's "Send test" button. Answer 2xx and do nothing else. */
export interface TestEvent {
  id: string
  type: 'test'
  created_at: string
  livemode?: boolean
  data: { message: string }
}
export type WebhookEvent = OrderEvent | SettlementEvent | RefundEvent | TestEvent

/* ───────── parameters ───────── */

export interface OrderCreateParams {
  /** Decimal string: "15.00". USDT, USDC and USD accept up to 6 decimals. */
  amount: string
  currency: Currency
  /** Your reference (up to 120 characters). The same value returns the same order. */
  external_id?: string
  /** Up to 300 characters; the customer sees it. */
  description?: string
  customer?: { email?: string; name?: string }
  /** An http or https URL on your own site (up to 500 characters): where the checkout sends the customer after the payment. */
  redirect_url?: string
  /** From 5 to 1440. */
  expires_in_min?: number
  /** Language of the emails to the customer. If the customer opens the checkout, the language they see there wins. With no value, your account's email language, else English. */
  locale?: 'en' | 'es'
  /** Up to 4,000 characters as JSON; it comes back in the order and its webhooks. Line items go here: { items: [{ name, quantity, price }] }. */
  metadata?: Record<string, unknown>
  /** The network the order is paid on: chain_id (56) or key ("bsc"). Without it, the customer picks it at checkout. */
  network?: number | string
  /** charge (the default) or deposit: a deposit credits whatever arrives. */
  mode?: 'charge' | 'deposit'
}

export interface OrderListParams {
  /** From 1 to 100 (20 by default). */
  limit?: number
  status?: OrderStatus
  /** Only orders created before this date: for the next page, pass the created_at of the last one. */
  before?: string | Date
}

export interface SettlementListParams {
  /** From 1 to 100 (20 by default). */
  limit?: number
  /** Only payouts older than this one: for the next page, pass the id (stl_...) of the last one. */
  before?: string
}

export interface RefundCreateParams {
  order_id: string
  /** By default, everything still refundable in the coin the order was paid with (what arrived minus what was already refunded). At least 1 USD. */
  amount?: string
  reason?: string
}

export interface WebhookSetParams {
  /** https://... */
  url: string
  /** true: generates a new secret (the previous one stops validating). */
  rotate_secret?: boolean
}

/** The minimum the SDK uses from fetch (the global fetch of Node 18+ qualifies). */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: any },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; headers?: { get(name: string): string | null } }>

export interface SadayaOptions {
  /** sk_live_... (real money) or sk_test_... (test mode). Only on your server. */
  apiKey: string
  /** https://api.sadaya.app by default. */
  baseUrl?: string
  /** Maximum time per request, in milliseconds (20000 by default). */
  timeoutMs?: number
  /** Your own fetch (tests, proxy). The global fetch by default. */
  fetch?: FetchLike
  /**
   * Verifies every order with an address that the API returns before handing it to you: its route pays you, its
   * address matches and each payment link (uri) pays that address. If not, it throws SadayaVerificationError and you
   * must not show it. An order with no chosen network (deposit_address null) comes back as it is: it has no address to
   * show or to verify (if it carried a uri, it throws check 'uri').
   */
  verify?: VerifyExpected
}

export interface VerifyWebhookOptions {
  /** Seconds allowed between the signature and your clock (300 by default). */
  toleranceSec?: number
  /** Current time in milliseconds (Date.now() by default). */
  now?: number | Date
}

/* ───────── client ───────── */

export declare class Sadaya {
  constructor(options: SadayaOptions)
  readonly baseUrl: string
  readonly timeoutMs: number
  /** true with sk_live_, false with sk_test_. */
  readonly livemode: boolean
  readonly orders: {
    create(params: OrderCreateParams): Promise<Order>
    get(id: string): Promise<OrderWithPayments>
    /** Seals the order for a network and returns it with its address (verified, with the verify option). Only once: another network answers 409. */
    chooseNetwork(id: string, network: number | string): Promise<Order>
    list(params?: OrderListParams): Promise<List<Order>>
    /** "Check now": looks at the chain for this order right now (limited per account: 429 with retryAfter) and returns it. */
    check(id: string): Promise<OrderWithPayments>
    /** Cancels an order that never received anything (409 otherwise) and returns it. Again: the same order, as it is. */
    cancel(id: string): Promise<OrderWithPayments>
    /**
     * Accepts an underpaid order as paid with what it received (flags.accepted; order.paid once) and returns it. Off until
     * the owner turns it on in Developers (403); not underpaid, or a payment still confirming or held, 409; past the hourly
     * limit, 429 with retryAfter. Again: the same order, as it is.
     */
    accept(id: string): Promise<OrderWithPayments>
  }
  /** Your payouts, exactly as settlement.paid carried them. Live only: with a test key the list is empty. */
  readonly settlements: {
    list(params?: SettlementListParams): Promise<List<Settlement>>
    get(id: string): Promise<Settlement>
  }
  /** Your account's networks, the same in test and live mode: offer only these in your own network picker. */
  readonly networks: {
    list(): Promise<List<AccountNetwork>>
  }
  readonly refunds: {
    create(params: RefundCreateParams): Promise<Refund>
    get(id: string): Promise<Refund>
    list(params?: RefundListParams): Promise<{ object: 'list'; data: Refund[] }>
    markSent(id: string, params: { tx_hash: string }): Promise<Refund>
    cancel(id: string): Promise<Refund>
  }
  readonly webhook: {
    get(): Promise<WebhookEndpoint>
    set(params: WebhookSetParams): Promise<WebhookEndpoint>
  }
}

/** A network of your account (GET /v1/networks). */
export interface AccountNetwork {
  /** chain_id, as `network` takes it when you create an order. */
  id: number
  name: string
  /** The network's own coin: ETH, BNB or POL. */
  native: string
  /** The dollar stablecoins an order takes there, one to one. */
  tokens: string[]
  /** The smallest order this network takes, in dollars. */
  min_usd: number
}

export declare class SadayaError extends Error {
  constructor(message: string, options?: { status?: number; type?: string; body?: unknown; retryAfter?: number | null; cause?: unknown })
  /** HTTP status code; 0 when there was no response (connection error or timeout). */
  status: number
  type: ErrorType | (string & {})
  /** Seconds to wait before retrying, from the response's Retry-After header (a 429 carries it); null without one. */
  retryAfter: number | null
  /** The API's response, exactly as it came. */
  body: unknown
}

export declare class SadayaSignatureError extends Error {
  constructor(message: string)
}

/**
 * Verifies a webhook's signature (HMAC-SHA256, constant time, 300 s window) and returns the event.
 * Throws SadayaSignatureError if it is not valid.
 */
export declare function verifyWebhook(
  rawBody: string | Uint8Array | ArrayBuffer,
  signatureHeader: string | string[] | null | undefined,
  secret: string,
  options?: VerifyWebhookOptions,
): WebhookEvent

export default Sadaya
