// Google sends the user back here; hand the code to the page that opened us.
const p = new URLSearchParams(location.search)
const msg = { type: 'havuz-auth', code: p.get('code'), state: p.get('state'), error: p.get('error') }
if (window.opener) {
  window.opener.postMessage(msg, location.origin)
  window.close()
} else {
  document.getElementById('m').textContent = 'Bu pencereyi kapatıp havuz sekmesine dön.'
}
