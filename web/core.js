// havuz web core: encryption + parity, no Google, no DOM.
// Runs in the browser and in Node (tests). Everything here is pure logic;
// the storage is passed in as a "backend" object:
//
//   backend.upload(account, name, bytes) -> id
//   backend.download(account, id)        -> bytes
//   backend.remove(account, id)
//   backend.free(account)                -> bytes still free
//
// Files are encrypted on the user's own device with AES-256-GCM, using a key
// made from a password only the user knows (PBKDF2-SHA256, 600k rounds).
// The encrypted bytes are cut into stripes; every stripe gets one XOR parity
// shard, and every shard goes to a different Google account. Losing any one
// account loses nothing.

export const CHUNK = 4 * 1024 * 1024
const PBKDF2_ROUNDS = 600000
const MAGIC = new TextEncoder().encode('HVZ1')

const subtle = globalThis.crypto.subtle

export function randomBytes(n) {
  const b = new Uint8Array(n)
  globalThis.crypto.getRandomValues(b)
  return b
}

export async function deriveKey(password, salt) {
  const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ROUNDS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

// encrypt -> [12-byte IV][ciphertext + 16-byte tag]
export async function encrypt(key, bytes) {
  const iv = randomBytes(12)
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv, 0)
  out.set(ct, 12)
  return out
}

export async function decrypt(key, bytes) {
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12)))
  } catch {
    throw new Error('could not decrypt: wrong password or damaged data')
  }
}

export async function sha256hex(bytes) {
  const h = new Uint8Array(await subtle.digest('SHA-256', bytes))
  return Array.from(h, b => b.toString(16).padStart(2, '0')).join('')
}

export function splitEven(bytes, k) {
  const len = Math.ceil(bytes.length / k)
  const out = []
  for (let i = 0; i < k; i++) out.push(bytes.subarray(Math.min(i * len, bytes.length), Math.min((i + 1) * len, bytes.length)))
  return out
}

export function xorParity(shards) {
  const len = Math.max(0, ...shards.map(s => s.length))
  const p = new Uint8Array(len)
  for (const s of shards) for (let i = 0; i < s.length; i++) p[i] ^= s[i]
  return p
}

// accounts that can still take a shard, most free first
export function pickStripe(accounts, free, shardSize) {
  const room = accounts.filter(a => free[a] >= shardSize).sort((a, b) => free[b] - free[a])
  if (room.length < 3) throw new Error('fewer than 3 accounts have room left; add accounts or free some space')
  return { parity: room[0], data: room.slice(1) }
}

// how much plain data fits, playing the placement rule forward
export function usable(freeList) {
  const units = freeList.map(f => Math.floor(f / (CHUNK + 64)))
  let total = 0
  for (;;) {
    const room = units.map((u, i) => [u, i]).filter(([u]) => u > 0).sort((a, b) => b[0] - a[0])
    if (room.length < 3) return total * CHUNK
    const steps = Math.min(room[room.length - 1][0], 64)
    for (const [, i] of room) units[i] -= steps
    total += steps * (room.length - 1)
  }
}

// putFile reads `size` bytes through readAt(offset, length) -> Uint8Array
export async function putFile({ name, size, readAt, backend, accounts, key, onProgress = () => {} }) {
  const free = {}
  for (const a of accounts) free[a] = await backend.free(a)
  if (accounts.length >= 3 && size > usable(accounts.map(a => free[a]))) {
    throw new Error(`not enough space for ${name}`)
  }
  const entry = { name, size, created: Date.now(), stripes: [] }
  const uploaded = []
  const undo = async () => { for (const [a, id] of uploaded) { try { await backend.remove(a, id) } catch {} } }
  let offset = 0, piece = 0
  try {
    do {
      const plan = pickStripe(accounts, free, CHUNK + 64)
      const k = plan.data.length
      const plain = await readAt(offset, Math.min(k * CHUNK, size - offset))
      const sealed = await encrypt(key, plain)
      const shards = splitEven(sealed, k)
      const parity = xorParity(shards)
      const stripe = { len: sealed.length, shards: [], parity: null }
      const send = async (account, bytes) => {
        const id = await backend.upload(account, `${entry.created}.${String(piece++).padStart(5, '0')}.hvz`, bytes)
        uploaded.push([account, id])
        free[account] -= bytes.length
        return { account, id, size: bytes.length, sha256: await sha256hex(bytes) }
      }
      for (let i = 0; i < k; i++) stripe.shards.push(await send(plan.data[i], shards[i]))
      stripe.parity = await send(plan.parity, parity)
      entry.stripes.push(stripe)
      offset += plain.length
      onProgress(offset, size)
    } while (offset < size)
  } catch (e) {
    await undo()
    throw e
  }
  return entry
}

// readStripes yields the plain bytes of each stripe in order. Pieces on
// accounts in `lost`, or that fail or don't match their checksum, are rebuilt
// from parity (at most one per stripe).
export async function* readStripes({ entry, backend, key, lost = new Set(), onRebuild = () => {} }) {
  for (let si = 0; si < entry.stripes.length; si++) {
    const st = entry.stripes[si]
    const fetchOk = async c => {
      if (lost.has(c.account)) return null
      try {
        const b = await backend.download(c.account, c.id)
        return (await sha256hex(b)) === c.sha256 ? b : null
      } catch { return null }
    }
    const shards = []
    let missing = -1
    for (let i = 0; i < st.shards.length; i++) {
      const b = await fetchOk(st.shards[i])
      if (!b) {
        if (missing >= 0) throw new Error(`stripe ${si + 1}: pieces on ${st.shards[missing].account} and ${st.shards[i].account} are both gone; one parity can rebuild only one`)
        missing = i
      }
      shards.push(b)
    }
    if (missing >= 0) {
      const p = await fetchOk(st.parity)
      if (!p) throw new Error(`stripe ${si + 1}: piece on ${st.shards[missing].account} and the parity on ${st.parity.account} are both gone`)
      const rebuilt = p.slice()
      shards.forEach((b, i) => { if (i !== missing) for (let j = 0; j < b.length; j++) rebuilt[j] ^= b[j] })
      shards[missing] = rebuilt.subarray(0, st.shards[missing].size)
      onRebuild(si, st.shards[missing].account)
    }
    const sealed = new Uint8Array(st.len)
    let o = 0
    for (const b of shards) { sealed.set(b, o); o += b.length }
    yield await decrypt(key, sealed)
  }
}

export async function removeFile({ entry, backend }) {
  for (const st of entry.stripes) for (const c of [...st.shards, st.parity]) {
    try { await backend.remove(c.account, c.id) } catch {}
  }
}

// The index (list of files) is stored encrypted, a copy in every account.
// Layout: "HVZ1" + 16-byte salt + encrypted JSON. The salt is plain so the
// key can be made from the password before anything is decrypted.
export async function sealIndex(key, salt, index) {
  const body = await encrypt(key, new TextEncoder().encode(JSON.stringify(index)))
  const out = new Uint8Array(4 + 16 + body.length)
  out.set(MAGIC, 0); out.set(salt, 4); out.set(body, 20)
  return out
}

export function indexSalt(bytes) {
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) throw new Error('not a havuz index')
  return bytes.slice(4, 20)
}

export async function openIndex(key, bytes) {
  indexSalt(bytes)
  return JSON.parse(new TextDecoder().decode(await decrypt(key, bytes.subarray(20))))
}
