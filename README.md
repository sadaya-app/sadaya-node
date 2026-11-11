# @sadaya/node

Sadaya API client for Node.js: create, check, cancel and accept orders, look up payments and payouts, request refunds,
configure your webhook and verify its signatures. No dependencies: it uses the `fetch` of Node 18+ and `node:crypto`.

> **Server-side only.** Your API key (`sk_live_...` or `sk_test_...`) must never reach a browser, a mobile app or a
> repository. Keep it in an environment variable.

Full API reference: https://docs.sadaya.app

## Installation

```bash
npm install @sadaya/node
```

Requires Node 18 or later. It is an ESM module: load it with `import`. From CommonJS, load it with
`const { Sadaya } = await import('@sadaya/node')` inside an `async` function.

## Quick start

```js
import { Sadaya } from '@sadaya/node'

const sadaya = new Sadaya({ apiKey: process.env.SADAYA_API_KEY })

// in your store's "pay" route
const order = await sadaya.orders.create({
  amount: '15.00',                          // always a decimal string, never a number
  currency: 'USDT',
  external_id: 'order-1024',                // your order number: retrying never creates a second charge
  description: 'Starter Pack',
  customer: { email: 'jane@example.com', name: 'Jane Doe' },
  redirect_url: 'https://your-store.com/thanks?order=1024',
})

res.redirect(303, order.checkout_url)      // the customer pays on Sadaya's checkout
```

At checkout, the customer picks a coin and a network and clicks "Got it, show the address" before the address shows
up (see [Choosing the network](#choosing-the-network)). Deliver the product when the `order.paid` webhook arrives (see
[Verifying webhooks](#verifying-webhooks)), never because the customer came back to your `redirect_url`. For a
deposit, the event is `order.credited` (see [Deposits](#deposits)).

## Options

| Option | Default | Purpose |
|---|---|---|
| `apiKey` | (required) | `sk_live_...` (real money) or `sk_test_...` (test mode). Validated when the client is created. |
| `baseUrl` | `https://api.sadaya.app` | The Sadaya API URL, without `/v1`. |
| `timeoutMs` | `20000` | Maximum time per request, in milliseconds. |
| `fetch` | `globalThis.fetch` | Your own `fetch` (tests, proxy). |
| `verify` | (no verification) | `{ payout, feeBps }`: every order with an address that the API returns is verified (its address and its payment links) before it reaches you. See [Verifying each order's address](#verifying-each-orders-address). |

`sadaya.livemode` is `true` with an `sk_live_` key and `false` with an `sk_test_` key. The client sends
`User-Agent: sadaya-node/1.0` (its major and minor version) and never reveals the key if you print the client with
`console.log`.

## Methods

| Method | Endpoint | Returns |
|---|---|---|
| `orders.create(params)` | `POST /v1/orders` | `Order` (201 when new, 200 if the `external_id` already existed) |
| `orders.get(id)` | `GET /v1/orders/{id}` | `Order` with `payments` and `refunds` |
| `orders.chooseNetwork(id, network)` | `POST /v1/orders/{id}/network` | `Order` with its address. Only once: another network answers 409 |
| `networks.list()` | `GET /v1/networks` | `{ object: 'list', data, has_more }`: your account's networks, the same in test and live mode. Offer only these in your own network picker |
| `orders.list(params)` | `GET /v1/orders` | `{ object: 'list', data, has_more }` |
| `orders.check(id)` | `POST /v1/orders/{id}/check` | `Order` with `payments` and `refunds`, after looking at the chain for it right now |
| `orders.cancel(id)` | `POST /v1/orders/{id}/cancel` | `Order` with `payments` and `refunds`, canceled. Only one that never received anything: otherwise 409 |
| `orders.accept(id)` | `POST /v1/orders/{id}/accept` | `Order` with `payments` and `refunds`, accepted as paid with what it received. Only an underpaid order, while accepting by API is on: otherwise 409 or 403 |
| `settlements.list(params)` | `GET /v1/settlements` | `{ object: 'list', data, has_more }`: your payouts, newest first, each as `settlement.paid` carried it |
| `settlements.get(id)` | `GET /v1/settlements/{id}` | `Settlement` |
| `refunds.create(params)` | `POST /v1/refunds` | `Refund` |
| `refunds.get(id)` | `GET /v1/refunds/{id}` | `Refund` |
| `refunds.list({ order_id })` | `GET /v1/refunds` | `{ object, data }` |
| `refunds.markSent(id, { tx_hash })` | `POST /v1/refunds/{id}/sent` | `Refund` |
| `refunds.cancel(id)` | `POST /v1/refunds/{id}/cancel` | `Refund` |
| `webhook.get()` | `GET /v1/webhook` | `{ object: 'webhook', url, secret_set }` |
| `webhook.set({ url, rotate_secret })` | `POST /v1/webhook` | The same, plus `secret` when it is created or rotated |

All of them return a promise and throw `SadayaError` if something fails.

### Orders

```js
const order = await sadaya.orders.get('6f1c2a7e-3b9d-4c51-9e0a-2d7f8b1c4e90')
console.log(order.status)      // pending, confirming, underpaid, paid, expired or canceled
console.log(order.received)    // received and confirmed, in the order's currency
console.log(order.payments)    // every payment seen: network, amount, tx_hash, status
```

`orders.list` returns the orders in your key's mode (test or live), newest first. For the next page, pass the
`created_at` of the last one in `before`:

```js
let before
while (true) {
  const page = await sadaya.orders.list({ limit: 100, status: 'paid', before })
  for (const order of page.data) console.log(order.id, order.amount, order.currency)
  if (!page.has_more || page.data.length === 0) break
  before = page.data[page.data.length - 1].created_at
}
```

Line items go in `metadata`, which comes back in the order and in every webhook (up to 4,000 characters of JSON):

```js
await sadaya.orders.create({
  amount: '25.00', currency: 'USD', external_id: 'order-1030',
  metadata: { items: [{ name: 'Starter Pack', quantity: 1, price: '15.00' }, { name: 'Extra seat', quantity: 2, price: '5.00' }] },
})
```

`orders.check(id)` looks at the chain for that order right now, like **Check now** in the dashboard, and returns it with
its payments. It shares the dashboard's limit for your account (a `429` brings `err.retryAfter`), it only looks at live
orders (a test order answers `400`: simulate its payment instead) and only while the order is watched (until its review
window ends; after that, `409`).

`orders.cancel(id)` cancels an order that never received anything (waiting or expired): the checkout stops showing its
address and you get `order.canceled`. One that already has a payment answers `409`, and canceling it again returns it as
it is. If money reaches a canceled order anyway, it counts as a late payment: a charge gets `order.late_payment` and a
deposit `order.credited`, with `flags.late`, and the order keeps its `canceled_at`.

`orders.accept(id)` accepts an underpaid order as paid with what it received (for example, 15 of 35 USD), when you
decide to deliver anyway: it becomes `paid`, `received` stays what really arrived, `flags.accepted`, `accepted_at` and
`accepted_by` say it, and you get `order.paid` once. It is off until your account's owner turns on accepting by API in
the dashboard (**Developers**, **API keys**); meanwhile it answers `403`. Only a charge in `underpaid` with every
payment that counts confirmed (none confirming, held or waiting for its price): otherwise `409`, with the reason. At most
20 per hour per account and mode, the dashboard included (`429`, with `err.retryAfter`). Accepting it again returns it as
it is, and every acceptance emails the owner. With it on, set each key's allowed IPs.

```js
const fresh = await sadaya.orders.check(order.id)   // payments the watcher had not seen yet show up here
const closed = await sadaya.orders.cancel(order.id)  // closed.status === 'canceled'
const taken = await sadaya.orders.accept(order.id)   // taken.status === 'paid', taken.flags.accepted === true
```

### Payouts

`settlements.list` returns your payouts, newest first, each exactly as the `settlement.paid` webhook carried it: its id
(`stl_...`), the network and transaction, the totals per token (gross, fee and net) and one line per order with your
`external_id`. For the next page, pass the `id` of the last one in `before`. A test key gets an empty list: test orders
are never paid out.

```js
let before
do {
  const page = await sadaya.settlements.list({ limit: 100, before })
  for (const s of page.data) console.log(s.id, s.tx_hash, s.totals)
  before = page.has_more ? page.data[page.data.length - 1].id : undefined
} while (before)

const one = await sadaya.settlements.get('stl_3f9a7c2e8b4d1f6a0c5e9b7d')
```

### Choosing the network

Each order is paid on a single network: its address is sealed for that network, and anything that arrives on another
network or in another coin does not count toward the order and may be lost. If your customer files a claim, it follows
the misdirected payments policy agreed with your merchant account; a return is not guaranteed.

- With `network` when you create the order (its `chain_id`, such as `56`, or its key, such as `'bsc'`), the order is
  born with its address. `orders.create` answers `400` if that network is not enabled for your account, or `409` if it
  cannot take this order (the message lists the networks it can be paid on).
- Without `network`, the customer picks it at Sadaya's checkout. Until then `deposit_address`, `route` and `network`
  are `null`, and so is each network's `uri`. If the order can only be paid on one network, it is born with that one.
- In your own checkout, choose it later with `orders.chooseNetwork`, only once: another network answers `409` (to
  charge on another network, create another order), a network the order does not offer answers `400`, and an order
  with no network that has already expired answers `409`.

```js
// with the network: the order is born with its address
const order = await sadaya.orders.create({ amount: '15.00', currency: 'USDT', external_id: 'order-1024', network: 'bsc' })

// without a network: deposit_address is null until the customer picks it at checkout, or until you pick it, once
const other = await sadaya.orders.create({ amount: '15.00', currency: 'USDT', external_id: 'order-1025' })
const sealed = await sadaya.orders.chooseNetwork(other.id, 56)
```

If you show the address yourself, first show the same notice as Sadaya's checkout: "This order is paid only with
{coin} on {network}. Anything you send on another network or in another coin does not count toward this order and
may be lost."

### Orders in dollars

```js
const order = await sadaya.orders.create({ amount: '49.90', currency: 'USD', external_id: 'order-2048' })
// order.networks lists USDT and USDC (one to one) and ETH or BNB with their price_usd, a Chainlink rate fixed when the
// order is created and valid until order.expires_at: for every network while none is chosen, and only for the chosen
// one afterwards
```

A late ETH or BNB payment is valued at the lower of that rate and the rate when Sadaya detects it: review
`order.late_payment` before delivering.

ETH can also be paid on BNB Chain, as its BEP-20 token (Binance-Peg ETH): that entry of `networks` has `symbol`
`ETH`, `label` `ETH (BEP-20)` and the token's address. It pays an order in `ETH` one to one, and an order in `USD` at
its own `price_usd`, with the same rule for late payments. Wrapped coins such as WETH or WBNB do not count toward any
order.

### Deposits

With `mode: 'deposit'` the order does not charge a set amount: it credits whatever arrives. It suits exchanges and
wallets, where the user announces how much they will deposit but may send more or less.

```js
const deposit = await sadaya.orders.create({ amount: '500', currency: 'USD', mode: 'deposit', network: 'bsc', external_id: 'deposit-881' })
```

- `amount` is what the user announced: the checkout shows it and each network's minimum applies to it, but it does not
  decide how much is credited.
- The order turns `paid` as soon as any amount is confirmed, and you get `order.credited`. If more arrives at the same
  address later, it is added up and you get another `order.credited`.
- `received` is the total credited so far: credit your user the difference from what you already credited.
- A deposit never goes through `underpaid` and never sends `order.paid` or `order.underpaid`. A late payment is
  credited all the same, with `flags.late`.
- In `USD`, a deposit takes dollars one to one (USDT, USDC and the other ones the network accepts) and also ETH and
  BNB (on BNB Chain, ETH as its BEP-20 token), each credited at its dollar price when it arrives, rounded down. In
  `networks` those coins come with `guide: true`: their `price_usd`, `amount` and `uri` are those of the price right
  now, only a guide for the announced `amount`. Each payment of the order carries the price it counted at (`price_usd`)
  and the dollars it credited (`value`). A coin whose price cannot be read yet waits: the deposit stays `confirming` and
  nothing is credited until its price is read. A deposit in `USDT` or `USDC` takes only dollars.

### Refunds

Sadaya never takes custody of your money: you send the refund from your payout wallet and Sadaya verifies it on chain.

```js
const refund = await sadaya.refunds.create({ order_id: order.id, reason: 'Order canceled' })
// 1. send refund.customer_url to your customer (if the order has their email, Sadaya sends it too):
//    that is where they leave the wallet that receives the refund
// 2. you get refund.address_received: send refund.amount of refund.symbol on refund.network to refund.address
// 3. record the hash of your transaction (or paste it in the dashboard: Refunds, Mark as sent): Sadaya verifies it
//    on chain and you get refund.completed (with tx_hash)
const done = await sadaya.refunds.markSent(refund.id, { tx_hash: '0x...' })
```

Without `amount`, everything still refundable is refunded: what arrived in the coin the order was paid with, minus what
was already refunded. A refund is at least 1 USD, and
an order has one open refund at a time (another one answers `409`). Once the customer enters their wallet it cannot
change: to send the refund elsewhere, cancel it and create a new one. A transaction that did not come from your payout
wallet stays `sent` until Sadaya checks it, and the customer is emailed only once the refund is `completed`.

### Configuring the webhook through the API

```js
const { secret } = await sadaya.webhook.set({ url: 'https://your-store.com/webhooks/sadaya' })
// store secret (whsec_...) in your environment variables: it is only returned this once

await sadaya.webhook.set({ url: 'https://your-store.com/webhooks/sadaya', rotate_secret: true })
// generates a new secret: the previous one stops validating immediately
```

`webhook.set` needs the live key (`sk_live_`): there is a single webhook for test and live mode, and with a test key
the API answers `403`.

## Verifying each order's address

Each order's address comes from a public formula: the official factory, the order id and its route (`route`). The
library recomputes it without trusting Sadaya and checks that the route pays you. If someone compromised Sadaya and
returned another address, another wallet, an inflated fee or another payment link, your store would not show it to
the customer.

```js
import { Sadaya, SadayaVerificationError } from '@sadaya/node'

const sadaya = new Sadaya({
  apiKey: process.env.SADAYA_API_KEY,
  // from YOUR configuration, never from the API: your payout wallet and your agreed fee (100 = 1%)
  verify: { payout: process.env.MY_PAYOUT_WALLET, feeBps: 100 },
})

try {
  // with network, the order is born with its address and comes back already verified
  const order = await sadaya.orders.create({ amount: '15.00', currency: 'USD', external_id: cart.id, network: 'bsc' })
  // you can now show order.deposit_address and each network's uri, or send the customer to order.checkout_url
} catch (err) {
  if (err instanceof SadayaVerificationError) {
    // err.check says what failed: route, payout, fee, fee_recipient, recovery, review, networks, address, uri or network
    // do not show the address; let Sadaya know
  }
  throw err
}
```

It checks that `route.merchant` is your wallet, that the fee is the agreed one (`feeBps`, or at most `maxFeeBps`),
that everything the checkout offers is in the accepted list (and, in a deposit, that every coin its route takes is
listed in `networks`; otherwise `check: 'networks'`), that the recomputed address is the order's, and that each
network's `uri` pays that address, with that token, on that network and for what is still due (`due_units`), exactly
as Sadaya builds it (otherwise, `check: 'uri'`). You can also pin `feeRecipient` and `recovery`. For a single order:
`verifyOrder(order, { payout, feeBps })`.

**With no chosen network there is nothing to verify.** An order created without `network` comes back with
`deposit_address`, `route` and each `uri` set to `null`, and the library returns it as it is (if it carried a `uri`,
it throws `check: 'uri'`). Verify it once it has an address: when you choose the network with `orders.chooseNetwork`,
or when you read it with `orders.get` after the customer chose it at checkout. `verifyOrder` on an order with no
network throws `check: 'network'`, so in a webhook only verify when `event.data.deposit_address` is not `null`: an
order that expires before anyone chooses its network arrives without an address.

Since factory v3, the address also seals who splits the order during the review window (`route.settler`) and until
when (`route.open_after`, in unix seconds). Verification rejects a window longer than `maxReviewDays` (31 by default)
with `check: 'review'`. Older orders (factory v2) verify as before.

This library already knows the next factory version and still verifies v3 and v2 orders. The fee (`feeBps` or
`maxFeeBps`) is required: without it, the fee each order charges you cannot be checked.

On Cloudflare Workers or in the browser you can import the verification alone, with no Node APIs:
`import { verifyOrder } from '@sadaya/node/verify'`.

If you send the customer to the hosted checkout, verification confirms that the order pays you; what the customer sees
on that page is served by Sadaya. To cover that too, show the verified address yourself: in your own checkout, with a
QR code of the bare address (every wallet and exchange can read it) and a button with each network's `uri` (the
library already checked that it pays that address), or with the embedded checkout and `expectedAddress`.

## Verifying webhooks

`verifyWebhook(rawBody, signatureHeader, secret, { toleranceSec = 300, now = Date.now() })` checks the
`X-Sadaya-Signature` signature (HMAC-SHA256, compared in constant time) and that it is no older than 300 seconds. It
returns the parsed event or throws `SadayaSignatureError`.

It needs the **raw body**, exactly as it arrived (string, Buffer or Uint8Array). If you parse it and turn it back into
text, the signature no longer matches.

### Express

```js
import express from 'express'
import { verifyWebhook, SadayaSignatureError } from '@sadaya/node'

const app = express()

// register this route BEFORE app.use(express.json()): it needs the unparsed body
app.post('/webhooks/sadaya', express.raw({ type: 'application/json' }), async (req, res) => {
  let event
  try {
    event = verifyWebhook(req.body, req.get('X-Sadaya-Signature'), process.env.SADAYA_WEBHOOK_SECRET)
  } catch (err) {
    if (err instanceof SadayaSignatureError) return res.status(400).send(err.message)
    throw err
  }

  if (!event.livemode && process.env.NODE_ENV === 'production') return res.sendStatus(200) // test events: deliver nothing

  switch (event.type) {
    case 'order.paid':
      await fulfillOrder(event.data.external_id, event.id) // once per order, even if the event repeats
      break
    case 'order.late_payment':                 // paid, but with a payment that arrived after the order expired
      await reviewLatePayment(event.data)      // price and stock may have changed: decide before delivering
      break
    case 'order.underpaid':
      await notifyCustomerMissingAmount(event.data)
      break
    case 'order.credited':                     // deposits: received is the total credited so far
      await creditDeposit(event.data.external_id, event.data.received) // credit the difference from what you already credited
      break
    case 'order.overpaid':                     // more reached a charge that was already paid: received is the new total
      await recordExtra(event.data.external_id, event.data.received) // the extra since the last notice is yours: refund or credit it
      break
    case 'order.expired':
      await releaseStock(event.data.external_id)
      break
    case 'settlement.paid':
      await recordSettlement(event.data)       // the net amount is already in your wallet
      break
    default:
      break                                    // ignore (with a 2xx) the types you do not use
  }
  res.sendStatus(200)                          // answer quickly: if the work is slow, queue it
})
```

### Next.js, Cloudflare Workers and others with `Request`

```js
import { verifyWebhook, SadayaSignatureError } from '@sadaya/node'

export async function POST(request) {
  const raw = await request.text()
  let event
  try {
    event = verifyWebhook(raw, request.headers.get('x-sadaya-signature'), process.env.SADAYA_WEBHOOK_SECRET)
  } catch (err) {
    if (err instanceof SadayaSignatureError) return new Response(err.message, { status: 400 })
    throw err
  }
  // ... handle event.type
  return new Response('ok')
}
```

On Cloudflare Workers, enable Node compatibility (`compatibility_flags = ["nodejs_compat"]`) and read the secret from
`env`.

## Errors

```js
import { SadayaError } from '@sadaya/node'

try {
  await sadaya.orders.create({ amount: '15.00', currency: 'USDT', external_id: 'order-1024' })
} catch (err) {
  if (err instanceof SadayaError) console.error(err.status, err.type, err.message)
  else throw err
}
```

| `err.type` | When |
|---|---|
| `invalid_request_error` | 400, 403, 404, 409 or 503: invalid data, something your account cannot do (a paused merchant, a test key in `webhook.set`), not found, a conflict, or Sadaya cannot create orders at that moment: `err.message` says which. Also an SDK usage error (a missing id), with `status` 0. |
| `authentication_error` | 401: invalid or revoked key. 403: the key has allowed IPs and the call came from another one. |
| `rate_limit_error` | 429: too many requests (for example, too many orders in a short time). Wait at least `err.retryAfter` seconds before retrying. |
| `api_error` | A 5xx without a type, or a response that is not JSON. |
| `connection_error` | No response: network down or timeout (`status` 0). |

`err.type` is the one the API sends; if the response has none, the SDK sets it from the HTTP status. `err.message` is
the API's own message, `err.retryAfter` the seconds of the response's `Retry-After` header (or `null` without one),
and `err.body` holds the full response for debugging.

The SDK never retries on its own. Retrying `orders.create` is safe if you send `external_id`: the same value returns
the same order, as it is (its `network` and `mode` do not change). If you created it without a network, choose it
with `orders.chooseNetwork`.

## Test mode

With an `sk_test_` key, orders come out with `livemode: false` and never touch a blockchain. The checkout shows
buttons to simulate the payment, and you get the same webhooks (with `livemode: false`). You can also simulate it
from code:

```js
const sandbox = new Sadaya({ apiKey: process.env.SADAYA_TEST_KEY })
const order = await sandbox.orders.create({ amount: '15.00', currency: 'USDT', external_id: 'test-1' })

// test orders only; this route takes no key
await fetch(`${sandbox.baseUrl}/api/public/orders/${order.id}/simulate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ kind: 'paid' }),   // 'paid' (what is still due) or 'partial' (half of what is still due)
})
```

If the order has no network, simulating the payment seals it on the first network, as if the customer had chosen it
(an order with no network that has already expired answers `409`). On a deposit, both kinds end in `paid` with
`order.credited`.

## TypeScript

Types are included (`index.d.ts`): `Order`, `OrderWithPayments`, `Network`, `Payment`, `Refund`, `Settlement`,
`WebhookEvent`, `OrderCreateParams`, `OrderListParams`, `SettlementListParams`, `RefundCreateParams` and more.
`WebhookEvent` narrows by `type`:

```ts
import { verifyWebhook, type WebhookEvent } from '@sadaya/node'

const event: WebhookEvent = verifyWebhook(raw, signature, secret)
if (event.type === 'settlement.paid') {
  for (const t of event.data.totals) console.log(t.symbol, t.net)
}
```
