// havuz-api.js: everything havuz does, with no user interface.
//
// A user interface (the demo in app.js, or any other) only calls these
// functions and draws what status() returns. Encryption, Google sign-in,
// parity and Drive uploads all live here, so a new design can never weaken them.
//
//   import { havuz } from './havuz-api.js'
//
//   const { email, step } = await havuz.signIn()      // step: 'unlock' | 'create'
//   const recoveryCode   = await havuz.createPool(pw)  // show it once, user must save it
//   await havuz.unlock(pw)
//   await havuz.recover(recoveryCode, newPw)           // forgot password
//   await havuz.addAccount({ onCode: ({ code, url }) => show(code, url), signal })
//   havuz.status()                                     // everything the screen needs
//   await havuz.upload(file, percent => ...)
//   const { blob, rebuilt } = await havuz.download(name)
//   await havuz.remove(name)
//   havuz.onChange(() => redraw())                     // called after every change
//
// Every error is an Error with a Turkish .message (safe to show as is) and a
// short .code a UI can react to: popup_blocked, popup_closed, wrong_password,
// wrong_recovery, weak_password, exists, other_pool, no_space, not_found, cancelled, google.

import * as core from './core.js'
import { CLIENT_ID, TOKEN_ENDPOINT, SCOPE } from './config.js'

const INDEX_NAME = 'havuz-index.hvz'
const REDIRECT = location.origin + '/callback.html'
const MIN_PASSWORD = 10

const state = {
  main: null,          // email of the account the user signed in with
  tokens: {},          // email -> { access, exp, refresh, kind }
  vault: null,         // opened with the password or the recovery code
  index: null,         // { accounts: [{email, refresh, kind}], files: [entry] }
  indexIds: {},        // email -> Drive id of that account's copy of the index
  quotas: {},          // email -> { used, limit, free }
  sealedIndex: null,
  uploading: 0,
}

const fail = (code, message) => Object.assign(new Error(message), { code })
const listeners = new Set()
// listeners get the fresh status, so a UI can redraw straight from it
const changed = () => { const s = havuz.status(); for (const cb of listeners) { try { cb(s) } catch {} } }
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function human(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB'
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB'
  if (b >= 1e3) return Math.round(b / 1e3) + ' KB'
  return b + ' bayt'
}

// ---------- Google sign-in (authorization code + PKCE, in a popup) ----------

async function connectGoogle({ hint = '', consent = false } = {}) {
  const verifier = b64url(core.randomBytes(48))
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  const st = b64url(core.randomBytes(16))
  const q = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPE,
    access_type: 'offline', code_challenge: challenge, code_challenge_method: 'S256', state: st,
    prompt: consent ? 'consent select_account' : 'select_account', include_granted_scopes: 'true',
  })
  if (hint) q.set('login_hint', hint)
  const popup = window.open('https://accounts.google.com/o/oauth2/v2/auth?' + q, 'havuz-auth', 'width=480,height=640')
  if (!popup) throw fail('popup_blocked', 'Açılır pencere engellendi. Bu site için açılır pencerelere izin ver.')
  const code = await new Promise((resolve, reject) => {
    const onMsg = e => {
      if (e.origin !== location.origin || e.data?.type !== 'havuz-auth') return
      window.removeEventListener('message', onMsg)
      clearInterval(watch)
      if (e.data.state !== st) return reject(fail('google', 'Giriş doğrulanamadı, tekrar dene.'))
      if (e.data.error || !e.data.code) return reject(fail('cancelled', 'Google girişi iptal edildi.'))
      resolve(e.data.code)
    }
    window.addEventListener('message', onMsg)
    const watch = setInterval(() => {
      if (popup.closed) { clearInterval(watch); window.removeEventListener('message', onMsg); reject(fail('popup_closed', 'Giriş penceresi kapatıldı.')) }
    }, 800)
  })
  const t = await tokenCall({ code, code_verifier: verifier, redirect_uri: REDIRECT })
  const tok = { access: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000, refresh: t.refresh_token || null, kind: 'web' }
  const about = await driveJSON(tok.access, 'GET', 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress),storageQuota')
  const email = about.user.emailAddress
  const old = state.tokens[email] || {}
  state.tokens[email] = tok.refresh ? tok : { ...old, access: tok.access, exp: tok.exp }
  setQuota(email, about.storageQuota)
  return email
}

async function tokenCall(body) {
  const r = await fetch(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(fail('google', 'Google anahtarı alınamadı: ' + (j.error || r.status)), { google: j.error })
  return j
}

async function accessToken(email) {
  const t = state.tokens[email]
  if (t?.access && Date.now() < t.exp) return t.access
  if (!t?.refresh) throw fail('google', `${email} için izin yok; hesabı yeniden bağla.`)
  const j = await tokenCall({ refresh_token: t.refresh, kind: t.kind || 'web' })
  t.access = j.access_token
  t.exp = Date.now() + (j.expires_in - 60) * 1000
  return t.access
}

// ---------- Google Drive ----------

async function driveRaw(token, method, url, body, ctype) {
  let last
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, attempt * attempt * 1500))
    try {
      const r = await fetch(url, { method, body, headers: { Authorization: 'Bearer ' + token, ...(ctype ? { 'Content-Type': ctype } : {}) } })
      if (r.status === 429 || r.status >= 500) { last = new Error('Drive HTTP ' + r.status); continue }
      if (!r.ok) throw Object.assign(new Error('Drive HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200)), { fatal: true, status: r.status })
      return r
    } catch (e) {
      if (e.fatal) throw e
      last = e
    }
  }
  throw last
}
const driveJSON = async (token, method, url, body, ctype) => (await driveRaw(token, method, url, body, ctype)).json()

const folders = {}
async function folderId(email) {
  if (folders[email]) return folders[email]
  const tok = await accessToken(email)
  const q = encodeURIComponent("name='havuz' and mimeType='application/vnd.google-apps.folder' and trashed=false")
  const r = await driveJSON(tok, 'GET', `https://www.googleapis.com/drive/v3/files?fields=files(id)&q=${q}`)
  if (r.files.length) return (folders[email] = r.files[0].id)
  const f = await driveJSON(tok, 'POST', 'https://www.googleapis.com/drive/v3/files?fields=id',
    JSON.stringify({ name: 'havuz', mimeType: 'application/vnd.google-apps.folder' }), 'application/json')
  return (folders[email] = f.id)
}

async function uploadBytes(email, name, bytes) {
  const tok = await accessToken(email)
  const parent = await folderId(email)
  const boundary = 'havuz' + b64url(core.randomBytes(9))
  const meta = JSON.stringify({ name, parents: [parent] })
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`, bytes, `\r\n--${boundary}--`,
  ])
  const f = await driveJSON(tok, 'POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', body, `multipart/related; boundary=${boundary}`)
  return f.id
}

const backend = {
  upload: uploadBytes,
  async download(email, id) {
    const r = await driveRaw(await accessToken(email), 'GET', `https://www.googleapis.com/drive/v3/files/${id}?alt=media`)
    return new Uint8Array(await r.arrayBuffer())
  },
  async remove(email, id) {
    try { await driveRaw(await accessToken(email), 'DELETE', `https://www.googleapis.com/drive/v3/files/${id}`) }
    catch (e) { if (e.status !== 404) throw e }
  },
  async free(email) { return state.quotas[email]?.free ?? 0 },
}

function setQuota(email, q) {
  const limit = Number(q.limit || 0) || 15e9, used = Number(q.usage || 0)
  state.quotas[email] = { used, limit, free: limit - used }
}
async function refreshQuotas() {
  await Promise.all(Object.keys(state.tokens).map(async email => {
    try {
      const a = await driveJSON(await accessToken(email), 'GET', 'https://www.googleapis.com/drive/v3/about?fields=storageQuota')
      setQuota(email, a.storageQuota)
    } catch { delete state.quotas[email] }
  }))
}
// Drive reports usage minutes late, so count our own pieces right away
const pieces = entry => entry.stripes.flatMap(st => [...st.shards, st.parity].filter(Boolean))
function adjustQuota(entry, sign) {
  for (const c of pieces(entry)) {
    const q = state.quotas[c.account]
    if (q) { q.used += sign * c.size; q.free -= sign * c.size }
  }
}

// ---------- the encrypted index ----------

async function findIndex(email) {
  const tok = await accessToken(email)
  const parent = await folderId(email)
  const q = encodeURIComponent(`name='${INDEX_NAME}' and '${parent}' in parents and trashed=false`)
  const r = await driveJSON(tok, 'GET', `https://www.googleapis.com/drive/v3/files?fields=files(id,modifiedTime)&orderBy=modifiedTime desc&q=${q}`)
  return r.files[0]?.id || null
}

async function saveIndex() {
  state.index.saved = Date.now()
  state.index.accounts = Object.entries(state.tokens).filter(([, t]) => t.refresh)
    .map(([email, t]) => ({ email, refresh: t.refresh, kind: t.kind || 'web' }))
  const sealed = await core.sealVault(state.vault, state.index)
  const fails = []
  // a copy in every account, so any single account is enough to open the pool
  await Promise.all(state.index.accounts.map(async ({ email }) => {
    try {
      const id = state.indexIds[email] || await findIndex(email)
      if (id) {
        await driveRaw(await accessToken(email), 'PATCH', `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, sealed, 'application/octet-stream')
        state.indexIds[email] = id
      } else {
        state.indexIds[email] = await uploadBytes(email, INDEX_NAME, sealed)
      }
    } catch { fails.push(email) }
  }))
  if (fails.length === state.index.accounts.length) throw fail('google', 'Dosya listesi hiçbir hesaba kaydedilemedi.')
  return fails // accounts that did not get the newest list (rare; retried on next save)
}

async function enter(vault, index) {
  state.vault = vault
  state.index = index
  localStorage.setItem('havuz.pool', '2')
  for (const a of index.accounts) {
    const t = state.tokens[a.email] || (state.tokens[a.email] = {})
    if (!t.refresh) { t.refresh = a.refresh; t.kind = a.kind || 'web' }
  }
  await refreshQuotas()
  changed()
}

// does this account's Drive hold the list of a different pool? (the header tag is readable without a password)
async function otherPool(email) {
  const id = await findIndex(email)
  if (!id) return false
  const bytes = await backend.download(email, id)
  if (core.poolTag(bytes) === core.vaultTag(state.vault)) { state.indexIds[email] = id; return false }
  return true
}

const findFile = name => state.index?.files.find(f => f.name === name)

// ---------- the public API ----------

export const havuz = {
  human,

  /** true once unlock/createPool/recover succeeded */
  get isOpen() { return !!state.vault },

  /** Sign in with the main Google account. Opens Google's popup: call it from a click. */
  async signIn() {
    // ask for long-lived permission unless this browser already opened a pool
    const email = await connectGoogle({ hint: localStorage.getItem('havuz.main') || '', consent: !localStorage.getItem('havuz.pool') })
    state.main = email
    localStorage.setItem('havuz.main', email) // only the address, never a token
    const id = await findIndex(email)
    if (id) {
      state.indexIds[email] = id
      state.sealedIndex = await backend.download(email, id)
    }
    const step = id && core.vaultFormat(state.sealedIndex) === 2 ? 'unlock' : 'create'
    return { email, step }
  },

  /** Make a new pool. Returns the recovery code: show it once and make the user save it. Call from a click. */
  async createPool(password) {
    if (!password || password.length < MIN_PASSWORD) throw fail('weak_password', `Şifre en az ${MIN_PASSWORD} karakter olsun.`)
    if (!state.tokens[state.main]?.refresh) {
      // this browser signed in before, so Google skipped the long-lived permission
      await connectGoogle({ hint: state.main, consent: true })
      if (!state.tokens[state.main]?.refresh) throw fail('google', 'Google kalıcı izni vermedi. myaccount.google.com/permissions adresinden havuz iznini kaldırıp tekrar dene.')
    }
    const { vault, recovery } = await core.createVault(password)
    state.vault = vault
    state.index = { version: 2, files: [], accounts: [] }
    await saveIndex()
    await enter(vault, state.index)
    return recovery
  },

  async unlock(password) {
    try {
      const { vault, index } = await core.openVault(state.sealedIndex, password)
      await enter(vault, index)
    } catch (e) {
      throw e.message.includes('password') ? fail('wrong_password', 'Şifre yanlış.') : e
    }
  },

  /** Forgot password: open with the recovery code and set a new password. */
  async recover(recoveryCode, newPassword) {
    if (!newPassword || newPassword.length < MIN_PASSWORD) throw fail('weak_password', `Yeni şifre en az ${MIN_PASSWORD} karakter olsun.`)
    let opened
    try { opened = await core.openVault(state.sealedIndex, recoveryCode, { recovery: true }) }
    catch (e) { throw e.message.includes('recovery') ? fail('wrong_recovery', 'Kurtarma anahtarı yanlış.') : e }
    await core.setPassword(opened.vault, newPassword)
    await enter(opened.vault, opened.index)
    await saveIndex()
  },

  /** Change the password; needs the current one. The recovery code keeps working. */
  async changePassword(current, next) {
    if (!(await core.checkPassword(state.vault, current))) throw fail('wrong_password', 'Mevcut şifre yanlış.')
    if (!next || next.length < MIN_PASSWORD) throw fail('weak_password', `Yeni şifre en az ${MIN_PASSWORD} karakter olsun.`)
    await core.setPassword(state.vault, next)
    await saveIndex()
  },

  /** Make a new recovery code (the old one stops working); needs the current password. Returns the code. */
  async newRecoveryCode(current) {
    if (!(await core.checkPassword(state.vault, current))) throw fail('wrong_password', 'Mevcut şifre yanlış.')
    const code = await core.setRecovery(state.vault)
    await saveIndex()
    return code
  },

  /**
   * Add a Google account signed in anywhere (another browser profile, a phone):
   * onCode({ code, url }) is called with a code to type at url. Resolves with the
   * new account's email once approved. Pass an AbortSignal to cancel.
   */
  async addAccount({ onCode, signal } = {}) {
    const d = await tokenCall({ device_start: true })
    onCode?.({ code: d.user_code, url: d.verification_url })
    let wait = (d.interval || 5) * 1000
    const until = Date.now() + 15 * 60 * 1000
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, wait))
      if (signal?.aborted) throw fail('cancelled', 'Vazgeçildi.')
      try {
        const t = await tokenCall({ device_code: d.device_code })
        const tok = { access: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000, refresh: t.refresh_token, kind: 'device' }
        const about = await driveJSON(tok.access, 'GET', 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress),storageQuota')
        const email = about.user.emailAddress
        if (state.tokens[email]?.refresh) throw fail('exists', `${email} zaten bu havuzda.`)
        state.tokens[email] = tok
        // one Google account belongs to one pool: refuse an account that holds another pool's list
        const other = await otherPool(email).catch(() => false)
        if (other) {
          delete state.tokens[email]; delete folders[email]; delete state.indexIds[email]
          throw fail('other_pool', `${email} başka bir Stashpool havuzuna bağlı. Bir hesap tek havuzda olabilir. Bu hesabı kullanmak istiyorsan önce o hesabın Google Drive'ındaki "havuz" klasörünü sil.`)
        }
        setQuota(email, about.storageQuota)
        await saveIndex()
        changed()
        return email
      } catch (e) {
        if (e.google === 'authorization_pending') continue
        if (e.google === 'slow_down') { wait += 5000; continue }
        throw e
      }
    }
    throw fail('cancelled', 'Kodun süresi doldu, tekrar dene.')
  },

  /** Everything the screen needs, ready to draw. */
  status() {
    const accounts = Object.keys(state.tokens)
      .sort((a, b) => (a === state.main ? -1 : b === state.main ? 1 : a.localeCompare(b)))
      .map(email => {
        const q = state.quotas[email]
        return { email, main: email === state.main, reachable: !!q, used: q?.used ?? 0, limit: q?.limit ?? 0 }
      })
    const used = accounts.reduce((s, a) => s + a.used, 0)
    const limit = accounts.reduce((s, a) => s + a.limit, 0)
    const files = (state.index?.files || []).map(f => ({ name: f.name, size: f.size, created: f.created }))
      .sort((a, b) => b.created - a.created)
    const n = accounts.length
    return {
      email: state.main,
      accounts,
      used, limit,                                   // across all accounts, in bytes
      percent: limit ? used / limit * 100 : 0,       // 0..100
      files,
      filesBytes: files.reduce((s, f) => s + f.size, 0),
      canStillStore: core.usable(accounts.map(a => state.quotas[a.email]?.free || 0)),
      protection: n >= 3 ? 'parity' : n === 2 ? 'copy' : n === 1 ? 'none' : 'no_accounts',
      // parity: survives losing any 1 account; copy: every file on both; none: unprotected
      busy: state.uploading > 0,
      isUnlocked: !!state.vault,
    }
  },

  /** Lock: forget every key and token in memory by reloading the page. */
  lock() {
    state.vault = null; state.index = null; state.tokens = {}; state.sealedIndex = null
    location.reload()
  },

  /** Store a File from an <input type=file> or drag and drop. onProgress gets 0..100. */
  async upload(file, onProgress = () => {}) {
    if (findFile(file.name)) throw fail('exists', `"${file.name}" zaten var; önce sil.`)
    state.uploading++
    changed()
    try {
      let entry
      try {
        entry = await core.putFile({
          name: file.name, size: file.size, backend, key: state.vault.key,
          accounts: Object.keys(state.tokens),
          readAt: async (o, n) => new Uint8Array(await file.slice(o, o + n).arrayBuffer()),
          onProgress: (done, all) => onProgress(all ? done / all * 100 : 100),
        })
      } catch (e) {
        throw /space|full|room/.test(e.message) ? fail('no_space', 'Havuzda yer kalmadı. Bir hesap ekle ya da dosya sil.') : e
      }
      state.index.files.push(entry)
      adjustQuota(entry, +1)
      changed()
      await saveIndex()
    } finally {
      state.uploading--
      changed()
    }
  },

  /** Download, check and decrypt a file. rebuilt = accounts whose pieces were rebuilt from parity. */
  async download(name) {
    const f = findFile(name)
    if (!f) throw fail('not_found', `"${name}" bulunamadı.`)
    const parts = [], rebuilt = new Set()
    for await (const p of core.readStripes({ entry: f, backend, key: state.vault.key, onRebuild: (_, acc) => rebuilt.add(acc) })) parts.push(p)
    return { blob: new Blob(parts), name: f.name, rebuilt: [...rebuilt] }
  },

  /** Delete a file from every account. Cannot be undone. */
  async remove(name) {
    const f = findFile(name)
    if (!f) throw fail('not_found', `"${name}" bulunamadı.`)
    await core.removeFile({ entry: f, backend })
    state.index.files = state.index.files.filter(x => x !== f)
    adjustQuota(f, -1)
    changed()
    await saveIndex()
  },

  /** cb(status) runs after every change (upload, delete, new account). Returns an unsubscribe function. */
  onChange(cb) { listeners.add(cb); return () => listeners.delete(cb) },
}
