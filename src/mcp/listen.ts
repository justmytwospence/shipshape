import { serve } from '@hono/node-server'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { Hono } from 'hono'
import { env } from '../config.ts'
import { createServer } from './server.ts'

/**
 * The MCP listener: a third port, never routed by the reverse proxy. Its only client is
 * the OAuth sidecar (agentgateway) on a private network, which checks the Authelia token
 * and strips it; nothing here authenticates. No MCP_PORT, no listener.
 */
export function createMcpApp(): Hono {
  const handler = createMcpHandler(createServer)
  const app = new Hono()
  app.get('/health', (c) => c.json({ ok: true }))
  app.all('/mcp', (c) => handler.fetch(c.req.raw))
  return app
}

export function startMcpServer(): void {
  if (!env.mcpPort) return
  serve({ fetch: createMcpApp().fetch, port: env.mcpPort }, (info) => {
    console.log(`[system] shipshape mcp listening on :${info.port}`)
  })
}
