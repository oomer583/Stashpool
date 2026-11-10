// Demo user interface. All real work happens in havuz-api.js; this file only
// draws havuz.status() and calls havuz.* on clicks. Replace it freely.
import { havuz, human } from './havuz-api.js'
import { CLIENT_ID } from './config.js'

const $ = s => document.querySelector(s)

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
const guard = fn => async ev => { ev?.preventDefault?.(); try { await fn(ev) } catch (e) { toast(e.message, true) } }

// ---------- screens ----------

$('#signin').onclick = guard(async () => {
  $('#signin').disabled = true
  try {
    const { email, step } = await havuz.signIn()
    for (const e of document.querySelectorAll('.who')) e.textContent = email
    for (const e of document.querySelectorAll('input[name=username]')) e.value = email
    show(step)
    $(step === 'unlock' ? '#unlock-pass' : '#create-pass').focus()
  } finally { $('#signin').disabled = false }
})

$('#unlock-form').onsubmit = guard(async () => {
  const btn = $('#unlock-btn'); btn.disabled = true; btn.textContent = 'Açılıyor…'
  try { await havuz.unlock($('#unlock-pass').value); show('main') }
  finally { btn.disabled = false; btn.textContent = 'Aç' }
})

$('#create-form').onsubmit = guard(async () => {
  if ($('#create-pass').value !== $('#create-pass2').value) return toast('Şifreler aynı değil.', true)
  const code = await havuz.createPool($('#create-pass').value)
  $('#rec-show').textContent = code
  show('recovery')
})

$('#rec-copy').onclick = () => navigator.clipboard.writeText($('#rec-show').textContent).then(() => toast('Kopyalandı.'))
$('#rec-continue').onclick = () => {
  if (!$('#rec-ok').checked) return toast('Önce kurtarma anahtarını bir yere kaydet.', true)
  $('#rec-show').textContent = ''
  show('main')
}

$('#forgot').onclick = e => { e.preventDefault(); show('recover') }
$('#recover-form').onsubmit = guard(async () => {
  if ($('#rec-pass').value !== $('#rec-pass2').value) return toast('Şifreler aynı değil.', true)
  await havuz.recover($('#rec-code').value, $('#rec-pass').value)
  show('main')
  toast('Yeni şifre kaydedildi. Kurtarma anahtarın aynı kaldı.')
})

let addAbort = null
$('#device-add').onclick = guard(async () => {
  addAbort?.abort()
  addAbort = new AbortController()
  const box = $('#device-box')
  try {
    const email = await havuz.addAccount({
      signal: addAbort.signal,
      onCode: ({ code, url }) => {
        box.hidden = false
        $('#device-code').textContent = code
        $('#device-url').textContent = url
        $('#device-url').href = url
      },
    })
    toast(email + ' eklendi.')
  } catch (e) { if (e.code !== 'cancelled') throw e } finally { box.hidden = true }
})
$('#device-cancel').onclick = () => { addAbort?.abort(); $('#device-box').hidden = true }

// ---------- main screen ----------

function render() {
  if (!havuz.isOpen) return
  const s = havuz.status()
  $('#gauge-pct').textContent = `%${s.percent < 10 ? s.percent.toFixed(1) : Math.round(s.percent)} dolu`
  $('#gauge-nums').textContent = `${human(s.used)} / ${human(s.limit)}`
  $('#gauge i').style.width = Math.min(100, s.percent) + '%'
  $('#gauge').classList.toggle('high', s.percent > 90)
  $('#summary').textContent = `Havuzdaki dosyalar: ${s.files.length} dosya, ${human(s.filesBytes)} · daha ${human(s.canStillStore)} sığar · ` + {
    none: 'KORUMASIZ: bu hesap kaybolursa dosyalar gider, bir hesap daha ekle',
    copy: 'her dosya iki hesapta da duruyor',
    parity: 'bir hesap kaybolsa da dosyalar güvende',
    no_accounts: 'hesap yok',
  }[s.protection]
  $('#summary').classList.toggle('bad', s.protection === 'none')
  $('#acc-count').textContent = s.accounts.length
  $('#drop').classList.toggle('off', !s.accounts.length)

  const list = $('#accounts'); list.replaceChildren()
  for (const a of s.accounts) {
    const row = el('li', {}, el('span', { class: 'email', text: a.email + (a.main ? ' (ana)' : '') }))
    if (a.reachable) {
      const bar = el('div', { class: 'bar' }, el('i'))
      bar.firstChild.style.width = Math.min(100, a.used / a.limit * 100) + '%'
      row.append(bar, el('span', { class: 'free', text: `${human(a.used)} / ${human(a.limit)}` }))
    } else row.append(el('span', { class: 'free bad', text: 'erişilemiyor' }))
    list.append(row)
  }

  const files = $('#files'); files.replaceChildren()
  if (!s.files.length) files.append(el('li', { class: 'empty', text: 'Henüz dosya yok.' }))
  for (const f of s.files) {
    files.append(el('li', {},
      el('span', { class: 'name', text: f.name }),
      el('span', { class: 'meta', text: `${human(f.size)} · ${new Date(f.created).toLocaleDateString()}` }),
      el('button', { text: 'İndir', onclick: guard(() => download(f.name)) }),
      el('button', { class: 'danger', text: 'Sil', onclick: guard(() => remove(f.name)) }),
    ))
  }
}
havuz.onChange(render)

async function download(name) {
  toast(`"${name}" hazırlanıyor…`)
  const { blob, rebuilt } = await havuz.download(name)
  const url = URL.createObjectURL(blob)
  el('a', { href: url, download: name }).click()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
  toast(rebuilt.length ? `İndirildi. Eksik parçalar pariteyle kuruldu: ${rebuilt.join(', ')}` : 'İndirildi, her parça doğrulandı.')
}

async function remove(name) {
  if (!confirm(`"${name}" bütün hesaplardan silinsin mi? Geri alınamaz.`)) return
  await havuz.remove(name)
}

// uploads one after another, each with its own progress bar
const queue = []
let pumping = false
function enqueue(fileList) {
  for (const f of fileList) {
    const item = el('li', {}, el('span', { class: 'name', text: f.name }), el('progress', { max: '100', value: '0' }))
    $('#uploads').append(item)
    queue.push({ f, item })
  }
  pump()
}
async function pump() {
  if (pumping) return
  pumping = true
  while (queue.length) {
    const { f, item } = queue.shift()
    try {
      await havuz.upload(f, p => { item.querySelector('progress').value = p })
      item.remove()
      toast(`"${f.name}" havuza kondu.`)
    } catch (e) {
      item.classList.add('bad')
      item.append(el('span', { class: 'meta', text: e.message }))
    }
  }
  pumping = false
}

$('#pick').onchange = e => { enqueue(e.target.files); e.target.value = '' }
const drop = $('#drop')
drop.ondragover = e => { e.preventDefault(); drop.classList.add('hover') }
drop.ondragleave = () => drop.classList.remove('hover')
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('hover'); enqueue(e.dataTransfer.files) }
window.addEventListener('beforeunload', e => { if (pumping || havuz.status().busy) { e.preventDefault(); e.returnValue = '' } })
if (CLIENT_ID.startsWith('PASTE')) toast('Kurulum bitmedi: config.js içine Google istemci kimliği yazılmalı.', true)
show('start')
