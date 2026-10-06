/**
 * The environment every `docker` subprocess that touches a stack runs with.
 *
 * Compose resolves `${VAR}` from the caller's environment *before* the stack's own
 * `.env` -- the shell wins. Inheriting shipshape's environment therefore handed its own
 * OPENROUTER_API_KEY, NTFY_TOKEN, PUID, ... to every stack that names the same variable
 * (opencode, n8n, paperless, hermes, crowdsec, ...), so a deploy from here resolved
 * differently from the same `docker compose up` on the host, and could put shipshape's
 * key -- with its own spending cap -- inside another service.
 *
 * Only what the docker CLI itself needs to reach the daemon and registries passes
 * through; every value a compose file interpolates comes from that stack's `.env`, as it
 * does on the host.
 */
const PASSTHROUGH = [
  'PATH',
  'HOME',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'DOCKER_API_VERSION',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const

export function dockerEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of PASSTHROUGH) {
    const v = source[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

/** execa options that replace -- not extend -- the inherited environment. */
export function dockerEnvOptions(): { env: Record<string, string>; extendEnv: false } {
  return { env: dockerEnv(), extendEnv: false }
}
