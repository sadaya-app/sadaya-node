// Bitcoin and Litecoin: the address of an order on either, derived again here from your own extended public key, so your
// store checks that the checkout shows your customer an address of your own wallet and nobody else's. BIP32 public derivation
// and native SegWit (BIP84: bc1q, ltc1q). No dependencies and no Node APIs, like the rest of the verification: SHA-256, SHA-512, HMAC,
// RIPEMD-160, secp256k1, base58check and bech32 are written here, and test/bitcoin.test.mjs checks them against their
// published vectors, BIP84's addresses and the gateway's own derivation.

/** Bitcoin and Litecoin have no chain id: the ones Sadaya uses for them, as the API writes them. */
export const BTC_ID = 20000000000001
export const LTC_ID = 20000000000003

/* ───────── SHA-256 and SHA-512, their constants computed from the primes (no table to mistype) ───────── */
const PRIMES = (() => { const out = []; for (let n = 2; out.length < 80; n++) if (out.every(p => n % p)) out.push(n); return out })()
/** The integer k-th root of n (BigInt), rounded down. */
function iroot(n, k) {
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / k) + 1)
  for (;;) { const y = ((BigInt(k) - 1n) * x + n / x ** (BigInt(k) - 1n)) / BigInt(k); if (y >= x) return x; x = y }
}
const frac64 = (p, k) => iroot(BigInt(p) << BigInt(64 * k), k) & ((1n << 64n) - 1n) // 64 bits of the fraction of p^(1/k)
const K512 = PRIMES.map(p => frac64(p, 3)), H512 = PRIMES.slice(0, 8).map(p => frac64(p, 2))
const K256 = Uint32Array.from(K512.slice(0, 64), x => Number(x >> 32n)), H256 = Uint32Array.from(H512, x => Number(x >> 32n))
const rotr = (x, n) => (x >>> n) | (x << (32 - n))
/** The message padded to whole blocks of `block` bytes, its length in bits in the last `lenBytes` (big-endian). */
function pad(data, block, lenBytes) {
  const out = new Uint8Array(Math.ceil((data.length + 1 + lenBytes) / block) * block)
  out.set(data)
  out[data.length] = 0x80
  let bits = BigInt(data.length) * 8n
  for (let i = out.length - 1; bits > 0n; i--, bits >>= 8n) out[i] = Number(bits & 0xffn)
  return out
}
export function sha256(data) {
  const m = pad(data, 64, 8), v = new DataView(m.buffer), H = H256.slice(), W = new Uint32Array(64)
  for (let o = 0; o < m.length; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = v.getUint32(o + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3), s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10)
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + W[i]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    ;[a, b, c, d, e, f, g, h].forEach((x, i) => { H[i] = (H[i] + x) >>> 0 })
  }
  const out = new Uint8Array(32), ov = new DataView(out.buffer)
  H.forEach((x, i) => ov.setUint32(i * 4, x))
  return out
}
const M64 = (1n << 64n) - 1n
const rotr64 = (x, n) => ((x >> n) | (x << (64n - n))) & M64
export function sha512(data) {
  const m = pad(data, 128, 16), H = H512.slice(), W = new Array(80)
  for (let o = 0; o < m.length; o += 128) {
    for (let i = 0; i < 16; i++) { let w = 0n; for (let j = 0; j < 8; j++) w = (w << 8n) | BigInt(m[o + i * 8 + j]); W[i] = w }
    for (let i = 16; i < 80; i++) {
      const s0 = rotr64(W[i - 15], 1n) ^ rotr64(W[i - 15], 8n) ^ (W[i - 15] >> 7n), s1 = rotr64(W[i - 2], 19n) ^ rotr64(W[i - 2], 61n) ^ (W[i - 2] >> 6n)
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) & M64
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let i = 0; i < 80; i++) {
      const t1 = (h + (rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n)) + ((e & f) ^ (~e & M64 & g)) + K512[i] + W[i]) & M64
      const t2 = ((rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n)) + ((a & b) ^ (a & c) ^ (b & c))) & M64
      h = g; g = f; f = e; e = (d + t1) & M64; d = c; c = b; b = a; a = (t1 + t2) & M64
    }
    ;[a, b, c, d, e, f, g, h].forEach((x, i) => { H[i] = (H[i] + x) & M64 })
  }
  const out = new Uint8Array(64)
  H.forEach((x, i) => { for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((x >> BigInt(56 - 8 * j)) & 0xffn) })
  return out
}
/** HMAC-SHA512 (RFC 2104): what BIP32 derives each child with. */
export function hmacSha512(key, data) {
  const k = new Uint8Array(128)
  k.set(key.length > 128 ? sha512(key) : key)
  const inner = new Uint8Array(128 + data.length), outer = new Uint8Array(128 + 64)
  for (let i = 0; i < 128; i++) { inner[i] = k[i] ^ 0x36; outer[i] = k[i] ^ 0x5c }
  inner.set(data, 128)
  outer.set(sha512(inner), 128)
  return sha512(outer)
}

/* ───────── RIPEMD-160 ───────── */
const RL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8, 3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
  1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2, 4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13]
const RR = [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2, 15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
  8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14, 12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11]
const SL = [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12, 11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
  11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12, 9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6]
const SR = [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11, 9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
  15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8, 8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11]
const KL = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e], KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000]
const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0
const rf = (j, x, y, z) => (j < 16 ? x ^ y ^ z : j < 32 ? (x & y) | (~x & z) : j < 48 ? (x | ~y) ^ z : j < 64 ? (x & z) | (y & ~z) : x ^ (y | ~z)) >>> 0
export function ripemd160(data) {
  // its length goes little-endian: the padding of the SHA family, with those 8 bytes reversed
  const m = pad(data, 64, 8), n = m.length
  m.subarray(n - 8).reverse()
  const v = new DataView(m.buffer), H = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0], X = new Array(16)
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) X[i] = v.getUint32(o + i * 4, true)
    let [al, bl, cl, dl, el] = H, [ar, br, cr, dr, er] = H
    for (let j = 0; j < 80; j++) {
      const r = j >> 4
      let t = (rotl((al + rf(j, bl, cl, dl) + X[RL[j]] + KL[r]) >>> 0, SL[j]) + el) >>> 0
      al = el; el = dl; dl = rotl(cl, 10); cl = bl; bl = t
      t = (rotl((ar + rf(79 - j, br, cr, dr) + X[RR[j]] + KR[r]) >>> 0, SR[j]) + er) >>> 0
      ar = er; er = dr; dr = rotl(cr, 10); cr = br; br = t
    }
    const t = (H[1] + cl + dr) >>> 0
    H[1] = (H[2] + dl + er) >>> 0; H[2] = (H[3] + el + ar) >>> 0; H[3] = (H[4] + al + br) >>> 0; H[4] = (H[0] + bl + cr) >>> 0; H[0] = t
  }
  const out = new Uint8Array(20), ov = new DataView(out.buffer)
  H.forEach((x, i) => ov.setUint32(i * 4, x, true))
  return out
}

/* ───────── secp256k1 (Jacobian coordinates: one inverse per point) ───────── */
const P = 2n ** 256n - 2n ** 32n - 977n, N = 2n ** 256n - 0x14551231950b75fc4402da1732fc9bebfn
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n, 1n]
const mod = a => ((a % P) + P) % P
function powMod(b, e) { let r = 1n; b = mod(b); for (; e > 0n; e >>= 1n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P } return r }
function dbl([X, Y, Z]) {
  if (Y === 0n) return null
  const S = mod(4n * X * Y * Y), M = mod(3n * X * X), X3 = mod(M * M - 2n * S)
  return [X3, mod(M * (S - X3) - 8n * Y ** 4n), mod(2n * Y * Z)]
}
function add(p, q) {
  if (!p) return q
  if (!q) return p
  const [X1, Y1, Z1] = p, [X2, Y2, Z2] = q, Z1s = mod(Z1 * Z1), Z2s = mod(Z2 * Z2)
  const U1 = mod(X1 * Z2s), U2 = mod(X2 * Z1s), S1 = mod(Y1 * Z2s * Z2), S2 = mod(Y2 * Z1s * Z1)
  if (U1 === U2) return S1 === S2 ? dbl(p) : null
  const H = mod(U2 - U1), R = mod(S2 - S1), H2 = mod(H * H), H3 = mod(H2 * H), X3 = mod(R * R - H3 - 2n * U1 * H2)
  return [X3, mod(R * (U1 * H2 - X3) - S1 * H3), mod(H * Z1 * Z2)]
}
function mul(k, p) { let r = null; for (let a = p; k > 0n; k >>= 1n, a = dbl(a)) if (k & 1n) r = add(r, a); return r }
function affine(p) { const zi = powMod(p[2], P - 2n), zi2 = mod(zi * zi); return [mod(p[0] * zi2), mod(p[1] * zi2 * zi)] }
const toBig = b => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n)
const toBytes = (n, len) => Uint8Array.from({ length: len }, (_, i) => Number((n >> BigInt(8 * (len - 1 - i))) & 0xffn))
/** A compressed public key (33 bytes) as a point, or null when it is not one of the curve. */
function decompress(b) {
  if (b.length !== 33 || (b[0] !== 2 && b[0] !== 3)) return null
  const x = toBig(b.subarray(1))
  if (x >= P) return null
  const y2 = mod(x ** 3n + 7n)
  let y = powMod(y2, (P + 1n) / 4n)
  if (mod(y * y) !== y2) return null
  if ((y & 1n) !== BigInt(b[0] & 1)) y = P - y
  return [x, y, 1n]
}
/** A point as its compressed public key (33 bytes). */
const compress = p => { const [x, y] = affine(p); const out = new Uint8Array(33); out[0] = y & 1n ? 3 : 2; out.set(toBytes(x, 32), 1); return out }

/* ───────── base58check, BIP32 and bech32 ───────── */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58check(s) {
  let n = 0n
  for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) return null; n = n * 58n + BigInt(i) }
  const bytes = []
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn))
  for (const ch of s) { if (ch !== '1') break; bytes.unshift(0) }
  if (bytes.length < 5) return null
  const b = Uint8Array.from(bytes), body = b.subarray(0, b.length - 4), sum = sha256(sha256(body))
  return sum.subarray(0, 4).every((x, i) => x === b[b.length - 4 + i]) ? body : null
}
// each network's prefix of its addresses and the public keys it takes, by their version bytes, all read as native SegWit:
// Bitcoin's xpub (BIP32) and zpub (BIP84); Litecoin's zpub and Ltub (its own BIP32 bytes)
const NETS = { bitcoin: { hrp: 'bc', versions: [0x0488b21e, 0x04b24746] }, litecoin: { hrp: 'ltc', versions: [0x04b24746, 0x019da462] } }
/** An extended public key of network `net` as { key (point), chain }, or null when it is not a valid one there. */
function parseKey(s, net) {
  const b = base58check(String(s ?? '').trim())
  if (!b || b.length !== 78) return null
  const version = new DataView(b.buffer, b.byteOffset).getUint32(0)
  if (!NETS[net]?.versions.includes(version)) return null
  const key = decompress(b.subarray(45, 78))
  return key ? { key, chain: b.slice(13, 45) } : null
}
/** BIP32's public derivation of child `i` (never hardened) of { key, chain }. */
function child({ key, chain }, i) {
  const data = new Uint8Array(37)
  data.set(compress(key))
  new DataView(data.buffer).setUint32(33, i)
  const I = hmacSha512(chain, data), il = toBig(I.subarray(0, 32))
  if (il >= N) throw new Error('an invalid child: the next index derives it')
  const k = add(mul(il, G), key)
  if (!k) throw new Error('an invalid child: the next index derives it')
  return { key: k, chain: I.slice(32) }
}
const hash160 = b => ripemd160(sha256(b))
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) { const top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i] }
  return chk
}
/** The 8-bit bytes as 5-bit words, padded at the end (BIP173's convertbits). */
function words(bytes) {
  const out = []
  let acc = 0, bits = 0
  for (const b of bytes) { acc = ((acc << 8) | b) & 0xfff; bits += 8; for (; bits >= 5; bits -= 5) out.push((acc >>> (bits - 5)) & 31) }
  if (bits) out.push((acc << (5 - bits)) & 31)
  return out
}
/** The native SegWit address (bc1q..., ltc1q...) of a 20-byte public key hash: bech32 (BIP173), witness version 0. */
function p2wpkh(hash, hrp) {
  // the prefix expanded: the high bits of each letter, a 0, their low bits
  const h = [...hrp].map(c => c.charCodeAt(0)), data = [0, ...words(hash)]
  const m = polymod([...h.map(c => c >> 5), 0, ...h.map(c => c & 31), ...data, 0, 0, 0, 0, 0, 0]) ^ 1
  return `${hrp}1${[...data, ...[0, 1, 2, 3, 4, 5].map(i => (m >>> (5 * (5 - i))) & 31)].map(d => CHARSET[d]).join('')}`
}

/** The address number `index` of `key` on network `net`, on `branch` (0 receive, the live orders; 1 change, the test ones), or null. */
function addressOf(net, key, index, branch) {
  const k = parseKey(key, net)
  if (!k || !Number.isInteger(index) || index < 0 || index >= 2 ** 31 || (branch !== 0 && branch !== 1)) return null
  return p2wpkh(hash160(compress(child(child(k, branch), index).key)), NETS[net].hrp)
}
/** The short id of `key` the API writes in an order's route (key_id): 16 hex of the hash160 of its public key, or null. */
function keyIdOf(net, key) {
  const k = parseKey(key, net)
  return k ? Array.from(hash160(compress(k.key)).subarray(0, 8), b => b.toString(16).padStart(2, '0')).join('') : null
}
/** Bitcoin: the address of `key` (an xpub or a zpub) at `index` on `branch`, and its short id. */
export const bitcoinAddress = (key, index, branch = 0) => addressOf('bitcoin', key, index, branch)
export const bitcoinKeyId = key => keyIdOf('bitcoin', key)
/** Litecoin: the address of `key` (a zpub or an Ltub) at `index` on `branch`, and its short id. */
export const litecoinAddress = (key, index, branch = 0) => addressOf('litecoin', key, index, branch)
export const litecoinKeyId = key => keyIdOf('litecoin', key)
