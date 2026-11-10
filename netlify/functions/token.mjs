// The only server-side piece of havuz on the web.
// Google gives long-lived (refresh) tokens only together with the client
// secret, which must never be shipped to browsers. This function adds the
// secret and forwards two tiny requests to Google:
//   { code, code_verifier, redirect_uri }  -> first connection of an account
//   { refresh_token }                      -> a fresh 1-hour access token
// No file data ever passes through here, and nothing is stored or logged.

const ALLOWED_ORIGIN = process.env.SITE_ORIGIN || process.env.URL

export default async req => {
  const origin = req.headers.get('origin')
  const cors = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (req.method !== 'POST' || origin !== ALLOWED_ORIGIN) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: cors })
  }
  let body
  try { body = await req.json() } catch { body = {} }

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
  })
  if (typeof body.code === 'string' && typeof body.code_verifier === 'string' && typeof body.redirect_uri === 'string') {
    if (!body.redirect_uri.startsWith(ALLOWED_ORIGIN + '/')) {
      return new Response(JSON.stringify({ error: 'bad redirect' }), { status: 400, headers: cors })
    }
    params.set('grant_type', 'authorization_code')
    params.set('code', body.code)
    params.set('code_verifier', body.code_verifier)
    params.set('redirect_uri', body.redirect_uri)
  } else if (typeof body.refresh_token === 'string') {
    params.set('grant_type', 'refresh_token')
    params.set('refresh_token', body.refresh_token)
  } else {
    return new Response(JSON.stringify({ error: 'bad request' }), { status: 400, headers: cors })
  }

  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: params })
  const j = await r.json()
  // pass back only what the page needs
  const out = r.ok
    ? { access_token: j.access_token, expires_in: j.expires_in, refresh_token: j.refresh_token }
    : { error: j.error || 'token_error' }
  return new Response(JSON.stringify(out), { status: r.ok ? 200 : 400, headers: cors })
}
