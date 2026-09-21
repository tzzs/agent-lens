/**
 * Static hosting of the built Web app (§13: "Hono + 静态 SPA 托管").
 *
 * Only files under `staticDir` are reachable: the node-server static middleware
 * resolves inside the root, and the SPA fallback serves exactly one file
 * (index.html), so no request can walk out of the build directory. This server
 * reads private logs — it must not also become a file read primitive.
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import type { ServerCtx } from './types.ts'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

export function registerStatic(app: Hono, ctx: ServerCtx): void {
  const dir = ctx.staticDir
  if (!dir) return
  app.use('/*', serveStatic({ root: dir, index: 'index.html' }))
  app.get('*', (c) => {
    const path = c.req.path
    if (path.startsWith('/api/')) {
      return c.json({ error: { kind: 'not_found', message: `no API route for ${path}` } }, 404)
    }
    const indexFile = join(dir, 'index.html')
    try {
      if (!statSync(indexFile).isFile()) throw new Error('not a file')
      return c.body(readFileSync(indexFile), 200, { 'content-type': 'text/html; charset=utf-8' })
    } catch {
      return c.json(
        {
          error: {
            kind: 'not_found',
            message: `no static build at ${dir} — run \`pnpm -F @agentlens/web build\``,
          },
        },
        404,
      )
    }
  })
}

export function contentTypeFor(file: string): string {
  const dot = file.lastIndexOf('.')
  return CONTENT_TYPES[file.slice(dot)] ?? 'application/octet-stream'
}
