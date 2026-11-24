import { existsSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { paths, env } from './env.ts'
import { type Policy, PolicySchema, retiredKeys, retiredKeysMessage } from './policy-schema.ts'

/**
 * Process-level constants come from the environment; everything the operator tunes
 * lives in the tracked policy.yaml inside the repository being watched. Per-service
 * data and exceptions live as `shipshape.*` labels on the services themselves -- read
 * from the compose files, never from running containers.
 *
 * Nothing here carries a default that assumes a particular deployment. The two values
 * that cannot be guessed -- which repository to watch, and where it lives on disk --
 * are required, and their absence produces setup instructions rather than a crash.
 */


/** Where the policy file is, repo-relative, and whether it exists yet. */
export function policyFileState(): { path: string; rel: string; exists: boolean } {
  return { path: paths.policy, rel: relative(env.repoDir, paths.policy) || paths.policy, exists: existsSync(paths.policy) }
}

const FALLBACK: Policy = PolicySchema.parse({})

let cached: { policy: Policy; raw: string } | null = null

/** Reads policy.yaml fresh from the repo. A malformed file is never fatal: the tool
 *  keeps running on the last good config (or defaults) and surfaces the error, because
 *  a syntax error should not take the updater offline. */
export function loadPolicy(): { policy: Policy; error?: string; missing?: true } {
  let raw: string
  try {
    raw = readFileSync(paths.policy, 'utf8')
  } catch {
    // An absent file is the normal first-run state: the defaults hold, and paused is true.
    return { policy: cached?.policy ?? FALLBACK, missing: true }
  }
  if (cached?.raw === raw) return { policy: cached.policy }
  const retired = retiredKeys(raw)
  if (retired.length > 0) return { policy: cached?.policy ?? FALLBACK, error: retiredKeysMessage(retired) }
  try {
    const parsed = PolicySchema.parse(parseYaml(raw) ?? {})
    // The tool's own stack is always excluded, whatever the operator wrote.
    parsed.exclude_stacks = [...new Set([...parsed.exclude_stacks, env.selfStack])]
    cached = { policy: parsed, raw }
    return { policy: parsed }
  } catch (err) {
    return {
      policy: cached?.policy ?? FALLBACK,
      error: `policy.yaml invalid: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** Check a candidate policy.yaml before it is allowed to replace the real one. */
export function validatePolicyText(raw: string): { ok: true } | { ok: false; error: string } {
  const retired = retiredKeys(raw)
  if (retired.length > 0) return { ok: false, error: retiredKeysMessage(retired) }
  try {
    PolicySchema.parse(parseYaml(raw) ?? {})
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 400) : String(err) }
  }
}
