import { parsePasswordConfig, type PasswordConfig } from './password.ts'
import { parseProxyConfig, type ProxyConfig } from './proxy.ts'

export type AuthConfig =
  | { mode: 'proxy'; proxy: ProxyConfig }
  | { mode: 'password'; password: PasswordConfig }
  | { mode: 'unconfigured' }
  | { mode: 'error'; problems: string[] }

/**
 * Which sign-in method the environment asks for. Read from process.env at app creation,
 * never from requests; there is no development or test bypass. A password and a trusted
 * proxy together are an error rather than a precedence rule nobody would remember.
 */
export function resolveAuth(): AuthConfig {
  const env = process.env
  const hasPassword = !!(env.SHIPSHAPE_PASSWORD || env.SHIPSHAPE_PASSWORD_FILE)
  const hasProxy = !!env.SHIPSHAPE_TRUSTED_PROXY?.trim()
  if (hasPassword && hasProxy) {
    return {
      mode: 'error',
      problems: [
        'SHIPSHAPE_PASSWORD (or SHIPSHAPE_PASSWORD_FILE) and SHIPSHAPE_TRUSTED_PROXY are both set. Use one sign-in method.',
      ],
    }
  }
  if (hasPassword) {
    const p = parsePasswordConfig(env)
    return p.ok ? { mode: 'password', password: p.config } : { mode: 'error', problems: p.problems }
  }
  if (hasProxy) {
    const p = parseProxyConfig(env)
    return p.ok ? { mode: 'proxy', proxy: p.config } : { mode: 'error', problems: p.problems }
  }
  return { mode: 'unconfigured' }
}

/** For startup logging. */
export function describeAuth(auth: AuthConfig = resolveAuth()): { mode: AuthConfig['mode']; problems: string[] } {
  return { mode: auth.mode, problems: auth.mode === 'error' ? auth.problems : [] }
}
