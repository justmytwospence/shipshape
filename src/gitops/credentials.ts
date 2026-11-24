import { env, type GitRemote } from '../env.ts'

/**
 * Which credential git is offered, and for which host.
 *
 * `compose` is the compose repository's GIT_TOKEN / GIT_USERNAME (GITHUB_TOKEN by default
 * on github.com), offered only to its remote's origin. `github` is GITHUB_TOKEN, offered
 * only to https://github.com, for the fork code. Kept apart from repo.ts so the auth probe
 * can use it without an import cycle.
 */

export type CredentialFor = 'compose' | 'github'

/**
 * Git config that supplies a token to one host and to nothing else. The empty helper clears
 * anything inherited from system config; the URL-scoped helper answers only for that origin,
 * so a redirect, a submodule or a fork URL on another host never receives the token. The
 * helper reads two variables that `credentialEnv` sets; nothing is embedded in the URL.
 */
export function credentialArgs(which: CredentialFor, remote: GitRemote = env.gitRemote): string[] {
  const reset = ['-c', 'credential.helper=']
  const origin = which === 'github' ? 'https://github.com' : remote.kind === 'https' ? new URL(remote.url).origin : null
  if (!origin) return reset
  return [
    ...reset,
    '-c',
    `credential.${origin}.helper=!f(){ echo username=$SHIPSHAPE_GIT_USERNAME; echo password=$SHIPSHAPE_GIT_PASSWORD; };f`,
  ]
}

export function credentialEnv(which: CredentialFor): Record<string, string> {
  return which === 'github'
    ? { SHIPSHAPE_GIT_USERNAME: 'x-access-token', SHIPSHAPE_GIT_PASSWORD: env.githubToken }
    : { SHIPSHAPE_GIT_USERNAME: env.gitUsername, SHIPSHAPE_GIT_PASSWORD: env.gitToken }
}
