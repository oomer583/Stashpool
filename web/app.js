// havuz web app: everything runs in the user's browser.
// Google tokens stay in memory (long-lived ones only inside the encrypted
// index), files are encrypted here, and pieces go straight to Google Drive.
import * as core from './core.js'
import { CLIENT_ID, TOKEN_ENDPOINT, SCOPE } from './config.js'

const INDEX_NAME = 'havuz-index.hvz'
const REDIRECT = location.origin + '/callback.html'
const $ = s => document.querySelector(s)

const state = {
  main: null,          // email of the account the user signed in with
  tokens: {},          // email -> { access, exp, refresh }
  key: null, salt: null,
  index: null,         // { accounts: [{email, refresh}], files: [entry] }
  indexIds: {},        // email -> Drive id of that account's index copy
  quotas: {},          // email -> { used, free }
}

// ---------- small helpers ----------

function human(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB'
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB'
  if (b >= 1e3) return Math.round(b / 1e3) + ' KB'
  return b + ' bayt'
}
function show(id) {
  for (const s of document.querySelectorAll('section.screen')) s.hidden = s.id !== id
}
function toast(text, bad = false) {
  const t = $('#toast')
  t.textContent = text
  t.className = bad ? 'bad' : ''
  t.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => { t.hidden = true }, bad ? 9000 : 4000)
}
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'onclick') e.onclick = v
    else if (k === 'text') e.textContent = v
    else e.setAttribute(k, v)
  }
  for (const k of kids) e.append(k)
  return e
}
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

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
  if (!popup) throw new Error('Açılır pencere engellendi. Bu site için açılır pencerelere izin ver.')
  const code = await new Promise((resolve, reject) => {
    const onMsg = e => {
      if (e.origin !== location.origin || e.data?.type !== 'havuz-auth') return
      window.removeEventListener('message', onMsg)
      clearInterval(watch)
      if (e.data.state !== st) return reject(new Error('Giriş doğrulanamadı, tekrar dene.'))
      if (e.data.error || !e.data.code) return reject(new Error('Google girişi iptal edildi.'))
      resolve(e.data.code)
    }
    window.addEventListener('message', onMsg)
    const watch = setInterval(() => {
      if (popup.closed) { clearInterval(watch); window.removeEventListener('message', onMsg); reject(new Error('Giriş penceresi kapatıldı.')) }
    }, 800)
  })
  const t = await tokenCall({ code, code_verifier: verifier, redirect_uri: REDIRECT })
  const tok = { access: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000, refresh: t.refresh_token || null }
  const about = await driveJSON(tok.access, 'GET', 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress),storageQuota')
  const email = about.user.emailAddress
  state.tokens[email] = { ...(state.tokens[email] || {}), ...tok, refresh: tok.refresh || state.tokens[email]?.refresh || null }
  setQuota(email, about.storageQuota)
  return email
}

async function tokenCall(body) {
  const r = await fetch(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error('Google anahtarı alınamadı: ' + (j.error || r.status))
  return j
}

async function accessToken(email) {
  const t = state.tokens[email]
  if (t?.access && Date.now() < t.exp) return t.access
  if (!t?.refresh) throw new Error(`${email} için izin yok; hesabı yeniden bağla.`)
  const j = await tokenCall({ refresh_token: t.refresh })
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
  const limit = Number(q.limit || 0), used = Number(q.usage || 0)
  state.quotas[email] = { used, free: limit ? limit - used : 15e9 }
}
async function refreshQuota(email) {
  const a = await driveJSON(await accessToken(email), 'GET', 'https://www.googleapis.com/drive/v3/about?fields=storageQuota')
  setQuota(email, a.storageQuota)
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
  state.index.accounts = Object.entries(state.tokens).filter(([, t]) => t.refresh).map(([email, t]) => ({ email, refresh: t.refresh }))
  const sealed = await core.sealIndex(state.key, state.salt, state.index)
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
    } catch (e) { fails.push(email) }
  }))
  if (fails.length === state.index.accounts.length) throw new Error('Dosya listesi hiçbir hesaba kaydedilemedi.')
  if (fails.length) toast('Liste şu hesaplara yazılamadı: ' + fails.join(', '), true)
}

// ---------- screens ----------

async function onSignIn() {
  $('#signin').disabled = true
  try {
    const email = await connectGoogle({ hint: localStorage.getItem('havuz.main') || '', consent: !localStorage.getItem('havuz.main') })
    state.main = email
    localStorage.setItem('havuz.main', email) // only the address, never a token
    const id = await findIndex(email)
    for (const e of document.querySelectorAll('.who')) e.textContent = email
    for (const e of document.querySelectorAll('input[name=username]')) e.value = email
    if (id) {
      state.indexIds[email] = id
      state.sealedIndex = await backend.download(email, id)
      show('unlock')
      $('#unlock-pass').focus()
    } else {
      show('create')
      $('#create-pass').focus()
    }
  } catch (e) { toast(e.message, true) } finally { $('#signin').disabled = false }
}

async function onUnlock(ev) {
  ev.preventDefault()
  const btn = $('#unlock-btn'); btn.disabled = true; btn.textContent = 'Açılıyor…'
  try {
    state.salt = core.indexSalt(state.sealedIndex)
    state.key = await core.deriveKey($('#unlock-pass').value, state.salt)
    state.index = await core.openIndex(state.key, state.sealedIndex)
    for (const a of state.index.accounts) {
      if (!state.tokens[a.email]) state.tokens[a.email] = { refresh: a.refresh }
      else if (!state.tokens[a.email].refresh) state.tokens[a.email].refresh = a.refresh
    }
    await openMain()
  } catch (e) {
    toast(e.message.includes('password') ? 'Şifre yanlış.' : e.message, true)
  } finally { btn.disabled = false; btn.textContent = 'Aç' }
}

async function onCreate(ev) {
  ev.preventDefault()
  const p1 = $('#create-pass').value, p2 = $('#create-pass2').value
  if (p1.length < 10) return toast('Şifre en az 10 karakter olsun.', true)
  if (p1 !== p2) return toast('Şifreler aynı değil.', true)
  if (!state.tokens[state.main]?.refresh) return toast('Ana hesabın kalıcı izni gelmedi; sayfayı yenileyip tekrar giriş yap.', true)
  state.salt = core.randomBytes(16)
  state.key = await core.deriveKey(p1, state.salt)
  state.index = { version: 1, files: [], accounts: [] }
  await saveIndex()
  await openMain()
}

async function openMain() {
  show('main')
  await Promise.all(Object.keys(state.tokens).map(e => refreshQuota(e).catch(() => {})))
  render()
}

function render() {
  const accs = Object.keys(state.tokens).sort((a, b) => (a === state.main ? -1 : b === state.main ? 1 : a.localeCompare(b)))
  const list = $('#accounts'); list.replaceChildren()
  let total = 0
  for (const email of accs) {
    const q = state.quotas[email]
    const row = el('li', {}, el('span', { class: 'email', text: email + (email === state.main ? ' (ana)' : '') }))
    if (q) {
      total += q.free
      const pct = Math.min(100, Math.round(q.used / (q.used + q.free) * 100))
      const bar = el('div', { class: 'bar' }, el('i'))
      bar.firstChild.style.width = pct + '%'
      row.append(bar, el('span', { class: 'free', text: human(q.free) + ' boş' }))
    } else row.append(el('span', { class: 'free bad', text: 'erişilemiyor' }))
    list.append(row)
  }
  const frees = accs.map(e => state.quotas[e]?.free || 0)
  $('#summary').textContent = accs.length >= 3
    ? `${accs.length} hesap · ${human(total)} boş · paritelı kullanılabilir: ${human(core.usable(frees))}`
    : `${accs.length} hesap bağlı · parite için en az 3 hesap gerekiyor`
  $('#drop').classList.toggle('off', accs.length < 3)

  const files = $('#files'); files.replaceChildren()
  if (!state.index.files.length) files.append(el('li', { class: 'empty', text: 'Henüz dosya yok.' }))
  for (const f of [...state.index.files].sort((a, b) => b.created - a.created)) {
    files.append(el('li', {},
      el('span', { class: 'name', text: f.name }),
      el('span', { class: 'meta', text: `${human(f.size)} · ${new Date(f.created).toLocaleDateString()}` }),
      el('button', { text: 'İndir', onclick: () => download(f) }),
      el('button', { class: 'danger', text: 'Sil', onclick: () => remove(f) }),
    ))
  }
}

async function onAddAccount(ev) {
  ev?.preventDefault()
  const want = $('#add-email').value.trim().toLowerCase()
  if (want && state.tokens[want]?.refresh) return toast(want + ' zaten bağlı.')
  try {
    // with a hint Google opens straight to that account's sign-in
    const email = await connectGoogle({ consent: true, hint: want })
    if (want && email.toLowerCase() !== want) toast(`Not: ${want} yerine ${email} bağlandı.`, true)
    $('#add-email').value = ''
    if (!state.tokens[email].refresh) throw new Error('Google kalıcı izin vermedi; myaccount.google.com/permissions adresinden havuz iznini kaldırıp tekrar dene.')
    await saveIndex()
    render()
    toast(email + ' eklendi.')
  } catch (e) { toast(e.message, true) }
}

// ---------- files ----------

const queue = []
let busy = false
function enqueue(fileList) {
  for (const f of fileList) {
    if (state.index.files.some(x => x.name === f.name)) { toast(`"${f.name}" zaten var; önce sil.`, true); continue }
    const item = el('li', {}, el('span', { class: 'name', text: f.name }), el('progress', { max: '100', value: '0' }))
    $('#uploads').append(item)
    queue.push({ f, item })
  }
  pump()
}
async function pump() {
  if (busy) return
  busy = true
  while (queue.length) {
    const { f, item } = queue.shift()
    const bar = item.querySelector('progress')
    try {
      const entry = await core.putFile({
        name: f.name, size: f.size, backend, key: state.key,
        accounts: Object.keys(state.tokens),
        readAt: async (o, n) => new Uint8Array(await f.slice(o, o + n).arrayBuffer()),
        onProgress: (done, all) => { bar.value = all ? Math.round(done / all * 100) : 100 },
      })
      state.index.files.push(entry)
      await saveIndex()
      item.remove()
      toast(`"${f.name}" havuza kondu.`)
    } catch (e) {
      item.classList.add('bad')
      item.append(el('span', { class: 'meta', text: e.message }))
    }
  }
  busy = false
  await Promise.all(Object.keys(state.tokens).map(e => refreshQuota(e).catch(() => {})))
  render()
}

async function download(f) {
  toast(`"${f.name}" hazırlanıyor…`)
  try {
    const parts = []
    let rebuilt = new Set()
    for await (const p of core.readStripes({ entry: f, backend, key: state.key, onRebuild: (_, acc) => rebuilt.add(acc) })) parts.push(p)
    const url = URL.createObjectURL(new Blob(parts))
    el('a', { href: url, download: f.name }).click()
    setTimeout(() => URL.revokeObjectURL(url), 60000)
    toast(rebuilt.size ? `İndirildi. Eksik parçalar pariteyle kuruldu: ${[...rebuilt].join(', ')}` : 'İndirildi, her parça doğrulandı.')
  } catch (e) { toast(e.message, true) }
}

async function remove(f) {
  if (!confirm(`"${f.name}" bütün hesaplardan silinsin mi? Geri alınamaz.`)) return
  try {
    await core.removeFile({ entry: f, backend })
    state.index.files = state.index.files.filter(x => x !== f)
    await saveIndex()
    await Promise.all(Object.keys(state.tokens).map(e => refreshQuota(e).catch(() => {})))
    render()
  } catch (e) { toast(e.message, true) }
}

// ---------- wire up ----------

$('#signin').onclick = onSignIn
$('#unlock-form').onsubmit = onUnlock
$('#create-form').onsubmit = onCreate
$('#add-form').onsubmit = onAddAccount
$('#pick').onchange = e => { enqueue(e.target.files); e.target.value = '' }
const drop = $('#drop')
drop.ondragover = e => { e.preventDefault(); drop.classList.add('hover') }
drop.ondragleave = () => drop.classList.remove('hover')
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('hover'); enqueue(e.dataTransfer.files) }
window.addEventListener('beforeunload', e => { if (busy || queue.length) { e.preventDefault(); e.returnValue = '' } })
if (CLIENT_ID.startsWith('PASTE')) toast('Kurulum bitmedi: config.js içine Google istemci kimliği yazılmalı.', true)
show('start')
