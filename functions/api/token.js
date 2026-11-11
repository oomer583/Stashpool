// Cloudflare Pages wrapper (serves /api/token); the logic lives in lib/token.mjs
import { handle } from '../../lib/token.mjs'
export const onRequest = ctx => handle(ctx.request, ctx.env)
