import { createHash, timingSafeEqual } from 'node:crypto'
import { serve } from '@hono/node-server'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { Hono } from 'hono'
import { env, MCP_TOKEN_MIN } from '../env.ts'
import { logEvent } from '../events.ts'
import { health } from '../health/liveness.ts'
import { serverHandle, type ServerHandle } from '../lifecycle.ts'
import { createServer } from './server.ts'

/**
 * The MCP listener: a port of its own, with the dashboard's reads and the operator's verbs.
 *
 * Every request to /mcp must carry `Authorization: Bearer <MCP_TOKEN>`; without a token of
 * at least 32 characters the listener does not start at all. The verbs here can ship and
 * deploy, so a network peer without the token gets nothing. An authenticating gateway in
 * front is still recommended when the port is reachable beyond one private network.
 */
export function createMcpApp(token: string): Hono {
  const handler = createMcpHandler(createServer)
  const expected = createHash('sha256').update(token).digest()
  const app = new Hono()
  app.get('/health', (c) => {
    const h = health()
    return c.json(h.body, h.status)
  })
  app.all('/mcp', (c) => {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')
    // Hashing both sides makes the lengths equal, so the comparison is constant-time.
    const presented = m ? createHash('sha256').update(m[1]!).digest() : null
    if (!presented || !timingSafeEqual(presented, expected)) {
      return new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'www-authenticate': 'Bearer realm="shipshape-mcp"',
        },
      })
    }
    return handler.fetch(c.req.raw)
  })
  return app
}

/** Starts the listener when MCP_PORT and MCP_TOKEN allow it; says why when they do not. */
export function startMcpServer(): ServerHandle | null {
  if (!env.mcpPort) return null
  if (env.mcpToken.length < MCP_TOKEN_MIN) {
    logEvent({
      level: 'error',
      kind: 'system',
      message: env.mcpToken
        ? 'MCP listener not started: MCP_TOKEN is shorter than 32 characters'
        : 'MCP listener not started: MCP_TOKEN is not set',
      detail:
        'set MCP_TOKEN to a random string of at least 32 characters (openssl rand -hex 32); clients send it as Authorization: Bearer <token>',
    })
    return null
  }
  const server = serve(
    { fetch: createMcpApp(env.mcpToken).fetch, port: env.mcpPort, hostname: env.mcpHost },
    (info) => {
      console.log(`[system] shipshape mcp listening on ${env.mcpHost}:${info.port}`)
    },
  )
  return serverHandle(server)
}
