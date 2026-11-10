// The only server-side piece of havuz on the web.
// Google gives long-lived (refresh) tokens only together with the client
// secret, which must never be shipped to browsers. This function adds the
// secret and forwards tiny requests to Google:
//   { code, code_verifier, redirect_uri }  first connection (popup sign-in)
//   { device_start: true }                 start a "type this code" connection
//   { device_code }                        check whether that code was approved
//   { refresh_token, kind }                a fresh 1-hour access token
// No file data ever passes through here, and nothing is stored or logged.

const ALLOWED_ORIGIN = process.env.SITE_ORIGIN || process.env.URL
const SCOPE = 'https://www.googleapis.com/auth/drive.file'

// two Google clients: "web" for the popup, "device" for codes typed at
// google.com/device (works from another browser profile or a phone, no password)
const clients = {
  web: { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET },
  device: { id: process.env.DEVICE_CLIENT_ID, secret: process.env.DEVICE_CLIENT_SECRET },
}

const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers })

export default async req => {
  const cors = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (req.method !== 'POST' || req.headers.get('origin') !== ALLOWED_ORIGIN) return json({ error: 'forbidden' }, 403, cors)
  let body
  try { body = await req.json() } catch { body = {} }

  const kind = body.kind === 'device' || body.device_start || body.device_code ? 'device' : 'web'
  const c = clients[kind]
  if (!c.id || !c.secret) return json({ error: `server is missing the ${kind} client settings` }, 500, cors)

  let url = 'https://oauth2.googleapis.com/token'
  const params = new URLSearchParams({ client_id: c.id })
  if (body.device_start === true) {
    url = 'https://oauth2.googleapis.com/device/code'
    params.set('scope', SCOPE)
  } else {
    params.set('client_secret', c.secret)
    if (typeof body.device_code === 'string') {
      params.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code')
      params.set('device_code', body.device_code)
    } else if (typeof body.code === 'string' && typeof body.code_verifier === 'string' && typeof body.redirect_uri === 'string') {
      if (!body.redirect_uri.startsWith(ALLOWED_ORIGIN + '/')) return json({ error: 'bad redirect' }, 400, cors)
      params.set('grant_type', 'authorization_code')
      params.set('code', body.code)
      params.set('code_verifier', body.code_verifier)
      params.set('redirect_uri', body.redirect_uri)
    } else if (typeof body.refresh_token === 'string') {
      params.set('grant_type', 'refresh_token')
      params.set('refresh_token', body.refresh_token)
    } else {
      return json({ error: 'bad request' }, 400, cors)
    }
  }

  const r = await fetch(url, { method: 'POST', body: params })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return json({ error: j.error || 'token_error' }, 400, cors)
  // pass back only what the page needs
  const keep = ['access_token', 'expires_in', 'refresh_token', 'device_code', 'user_code', 'verification_url', 'interval']
  return json(Object.fromEntries(keep.filter(k => j[k] !== undefined).map(k => [k, j[k]])), 200, cors)
}
