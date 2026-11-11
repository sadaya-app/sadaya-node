// Types for @sadaya/node/verify: verify an order's address without trusting Sadaya.

/** The route sealed into the order's address. */
export interface Route {
  /** Your payout wallet: it receives the net amount of what the order accepts. */
  merchant: string
  /** Sadaya's fee wallet. */
  fee_recipient: string
  /** Fee in basis points (100 = 1%). The contract accepts at most 1000. */
  fee_bps: number
  /** The wallet that handles misdirected payments; it can never move what the order accepts. */
  recovery: string
  /** The only assets that are split: network and token pairs (0x000... = the network's native coin). */
  accepted: { chain_id: number; token: string }[]
  /** The factory that creates the address (the same on every EVM network). */
  factory: string
  /** Factories v3 and v4: the only address that can split the order during the review window. */
  settler?: string
  /** Factories v3 and v4: when the review window ends (unix seconds). */
  open_after?: number
}

/** What your store knows on its own. Never take it from the API. */
export interface VerifyExpected {
  /** Your payout wallet. */
  payout: string
  /** Your agreed fee, exact, in basis points. This or maxFeeBps is required. */
  feeBps?: number
  /** Or the highest fee you accept. */
  maxFeeBps?: number
  /** Sadaya's fee wallet, if you want to pin it. */
  feeRecipient?: string
  /** The route's recovery address, if you want to pin it. */
  recovery?: string
  /** The longest review window you accept, in days (MAX_REVIEW_DAYS, 31, by default). */
  maxReviewDays?: number
  /** The moment of the check, in milliseconds (now, by default). */
  now?: number
}

/**
 * What failed. uri: a payment link does not pay the order's address. network: the order has no chosen network yet,
 * so it has no address; verify it once it has one.
 */
export type VerificationCheck = 'route' | 'payout' | 'fee' | 'fee_recipient' | 'recovery' | 'review' | 'networks' | 'address' | 'uri' | 'network'

/** The order failed verification: do not show its address. */
export declare class SadayaVerificationError extends Error {
  constructor(message: string, check: VerificationCheck)
  readonly name: 'SadayaVerificationError'
  /** What failed. */
  readonly check: VerificationCheck
}

/** The minimum of an order that is needed to verify it. */
export interface VerifiableOrder {
  id: string
  /** null while nobody has chosen the network: then there is no address to verify (check 'network'). */
  deposit_address: string | null
  /** A deposit's route may take a coin only if networks lists it (check 'networks'). */
  mode?: 'charge' | 'deposit'
  route?: Route | null
  /** With uri, each payment link is also checked to pay deposit_address for what is still due (due_units). */
  networks?: { chain_id: number; token: string | null; symbol?: string | null; due_units?: string; uri?: string | null }[]
}

/** Official factories (lowercase), the logic contract of their clones and their version (3 and 4: with a review window). */
export declare const FACTORIES: Readonly<Record<string, Readonly<{ implementation: string; version: 2 | 3 | 4 }>>>
/** The longest review window verifyOrder accepts by default, in days. */
export declare const MAX_REVIEW_DAYS: number
/** 0x0000000000000000000000000000000000000000: the native coin in the accepted list. */
export declare const NATIVE: string
/** Keccak-256, Ethereum's hash. */
export declare function keccak256(data: Uint8Array): Uint8Array
/** The address with its checksum capitals (EIP-55). */
export declare function toChecksumAddress(address: string): string
/** Recomputes the order's address with the contract's formula. */
export declare function depositAddressOf(order: VerifiableOrder): string
/**
 * Returns the order if its route pays you, its address matches and each payment link (uri) pays that address;
 * otherwise throws SadayaVerificationError. An order with no chosen network (no address) throws check 'network'.
 */
export declare function verifyOrder<T extends VerifiableOrder>(order: T, expected: VerifyExpected): T
