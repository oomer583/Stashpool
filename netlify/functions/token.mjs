// Netlify wrapper; the logic lives in lib/token.mjs
import { handle } from '../../lib/token.mjs'
export default req => handle(req, process.env)
export const config = { path: '/api/token' }
