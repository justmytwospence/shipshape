/** Non-routable test identity: never use production credentials or an auth bypass. */
export const TEST_PROXY = '192.0.2.18'
export const TEST_USER = 'shipshape-test-operator'
export const TEST_ORIGIN = 'https://shipshape.example.test'

/**
 * Hono's app.request third argument mocks Node transport bindings, not HTTP headers.
 * The real Node adapter supplies these from its incoming socket.
 */
export function socketBindings(address?: string) {
  return {
    incoming: {
      socket: {
        remoteAddress: address,
        remotePort: 43210,
        remoteFamily: address?.includes(':') ? 'IPv6' : 'IPv4',
      },
    },
  }
}
