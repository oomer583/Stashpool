// node web/core.test.mjs
import * as core from './core.js'
import assert from 'node:assert/strict'

class Fake {
  constructor(free) { this.files = new Map(); this.freeMap = { ...free }; this.n = 0; this.failAt = 0 }
  async upload(a, name, bytes) {
    if (++this.n === this.failAt) throw new Error('simulated network error')
    const id = `${a}/${this.n}`
    this.files.set(id, bytes.slice()); this.freeMap[a] -= bytes.length
    return id
  }
  async download(a, id) { if (!this.files.has(id)) throw new Error('404'); return this.files.get(id) }
  async remove(a, id) { this.files.delete(id) }
  async free(a) { return this.freeMap[a] }
}

const MB = 1024 * 1024
const salt = core.randomBytes(16)
const key = await core.deriveKey('correct horse battery staple', salt)

function source(size) {
  const data = new Uint8Array(size)
  for (let o = 0; o < size; o += 65536) data.set(core.randomBytes(Math.min(65536, size - o)), o)
  return { data, readAt: async (o, n) => data.slice(o, o + n) }
}

async function readAll(entry, backend, lost, k = key) {
  const parts = []
  for await (const p of core.readStripes({ entry, backend, key: k, lost })) parts.push(p)
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

const accounts = ['a', 'b', 'c', 'd']
const big = Object.fromEntries(accounts.map(a => [a, 500 * MB]))
let passed = 0
async function test(name, fn) { await fn(); passed++; console.log('ok  ', name) }

await test('round trip, every account used', async () => {
  const be = new Fake(big), { data, readAt } = source(25 * MB + 123)
  const entry = await core.putFile({ name: 'x', size: data.length, readAt, backend: be, accounts, key })
  const used = new Set(entry.stripes.flatMap(s => [...s.shards, s.parity].map(c => c.account)))
  assert.equal(used.size, 4)
  assert.deepEqual(await readAll(entry, be), data)
})

await test('survives losing any one account', async () => {
  const be = new Fake(big), { data, readAt } = source(30 * MB)
  const entry = await core.putFile({ name: 'x', size: data.length, readAt, backend: be, accounts, key })
  for (const lost of accounts) assert.deepEqual(await readAll(entry, be, new Set([lost])), data)
})

await test('really deleted account is rebuilt', async () => {
  const be = new Fake(big), { data, readAt } = source(9 * MB)
  const entry = await core.putFile({ name: 'x', size: data.length, readAt, backend: be, accounts, key })
  for (const id of [...be.files.keys()]) if (id.startsWith('b/')) be.files.delete(id)
  assert.deepEqual(await readAll(entry, be), data)
})

await test('corrupted piece is repaired', async () => {
  const be = new Fake(big), { data, readAt } = source(10 * MB)
  const entry = await core.putFile({ name: 'x', size: data.length, readAt, backend: be, accounts, key })
  be.files.get(entry.stripes[0].shards[1].id)[50] ^= 0xff
  assert.deepEqual(await readAll(entry, be), data)
})

await test('two lost accounts is a clear error', async () => {
  const be = new Fake(big), { data, readAt } = source(10 * MB)
  const entry = await core.putFile({ name: 'x', size: data.length, readAt, backend: be, accounts, key })
  await assert.rejects(readAll(entry, be, new Set(['a', 'b'])), /both gone/)
})

await test('wrong password cannot read', async () => {
  const be = new Fake(big), { data, readAt } = source(1 * MB)
  const entry = await core.putFile({ name: 'x', size: data.length, readAt, backend: be, accounts, key })
  const wrong = await core.deriveKey('guess', salt)
  await assert.rejects(readAll(entry, be, new Set(), wrong), /wrong password/)
})

await test('stored pieces do not contain the plain data', async () => {
  const be = new Fake(big)
  const text = new TextEncoder().encode('SECRET-'.repeat(50000))
  const entry = await core.putFile({ name: 'x', size: text.length, readAt: async (o, n) => text.slice(o, o + n), backend: be, accounts, key })
  const needle = Buffer.from('SECRET-SECRET-')
  for (const b of be.files.values()) assert.equal(Buffer.from(b).includes(needle), false)
  assert.deepEqual(await readAll(entry, be), text)
})

await test('small and empty files', async () => {
  for (const size of [0, 1, 1000, core.CHUNK, 3 * core.CHUNK - 1]) {
    const be = new Fake(big), { data, readAt } = source(size)
    const entry = await core.putFile({ name: 'x', size, readAt, backend: be, accounts, key })
    assert.deepEqual(await readAll(entry, be, new Set(['c'])), data, `size ${size}`)
  }
})

await test('one nearly full account does not cap the pool', async () => {
  const be = new Fake({ small: 9 * MB, b: 300 * MB, c: 300 * MB, d: 300 * MB })
  const { data, readAt } = source(80 * MB)
  const entry = await core.putFile({ name: 'x', size: data.length, readAt, backend: be, accounts: ['small', 'b', 'c', 'd'], key })
  for (const lost of ['small', 'b', 'c', 'd']) assert.deepEqual(await readAll(entry, be, new Set([lost])), data)
})

await test('failed upload leaves nothing behind', async () => {
  const be = new Fake(big); be.failAt = 6
  const { data, readAt } = source(20 * MB)
  await assert.rejects(core.putFile({ name: 'x', size: data.length, readAt, backend: be, accounts, key }))
  assert.equal(be.files.size, 0)
})

await test('fewer than 3 accounts is refused', async () => {
  const be = new Fake({ a: 500 * MB, b: 500 * MB }), { data, readAt } = source(MB)
  await assert.rejects(core.putFile({ name: 'x', size: data.length, readAt, backend: be, accounts: ['a', 'b'], key }), /fewer than 3/)
})

await test('remove deletes every piece', async () => {
  const be = new Fake(big), { data, readAt } = source(12 * MB)
  const entry = await core.putFile({ name: 'x', size: data.length, readAt, backend: be, accounts, key })
  await core.removeFile({ entry, backend: be })
  assert.equal(be.files.size, 0)
})

await test('encrypted index round trip, salt readable, wrong password fails', async () => {
  const idx = { files: [{ name: 'a.txt' }] }
  const sealed = await core.sealIndex(key, salt, idx)
  assert.deepEqual(core.indexSalt(sealed), salt)
  assert.deepEqual(await core.openIndex(key, sealed), idx)
  await assert.rejects(core.openIndex(await core.deriveKey('nope', salt), sealed), /wrong password/)
})

console.log(`\n${passed} passed`)
