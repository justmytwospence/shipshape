import { Cron } from 'croner'
import { logEvent } from '../events.ts'
import { commitPolicyFile } from '../gitops/policy-file.ts'
import { setValue } from './yaml.ts'
import { SETTINGS, type SettingDef } from './defs.ts'

export type ApplyResult =
  | { ok: true; applied: string[]; commit: string | null }
  /** `fields` holds the refusals tied to one setting, by path; `errors` every sentence. */
  | { ok: false; errors: string[]; fields?: Record<string, string> }


/** The success sentence: the settings by their labels, joined in words, and the commit. */
export function savedText(applied: string[], commit: string | null): string {
  const names = applied.map((p) => SETTINGS.find((d) => d.path === p)?.label ?? p)
  const words = names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return `Saved ${words}${commit ? `, committed as ${commit}` : ''}.`
}


export async function applySettings(changes: Record<string, string>): Promise<ApplyResult> {
  const errors: string[] = []
  const fields: Record<string, string> = {}
  const applied: string[] = []

  const result = await commitPolicyFile(
    (current) => {
      errors.length = 0
      applied.length = 0
      for (const k of Object.keys(fields)) delete fields[k]
      let text = current
      for (const [path, rawValue] of Object.entries(changes)) {
        const def = SETTINGS.find((s) => s.path === path)
        if (!def || def.locked) continue

        const value = rawValue.trim()
        const validation = validate(def, value)
        if (validation) {
          errors.push(`${def.label}: ${validation}`)
          fields[def.path] = validation
          continue
        }

        const spliced = setValue(text, path, format(def, value))
        if (!spliced) {
          // Only reachable for a path the splicer cannot even construct, which means a
          // malformed SettingDef rather than anything about the operator's file.
          errors.push(`${def.label}: "${path}" is not a settable key`)
          continue
        }
        if (spliced !== text) {
          text = spliced
          applied.push(path)
        }
      }
      if (errors.length > 0) return { error: 'settings were refused' }
      if (applied.length === 0) return { unchanged: true }
      return { text }
    },
    () => `chore(shipshape): settings: ${applied.join(', ')}`,
  )

  if (errors.length > 0) return { ok: false, errors: [...errors], fields: { ...fields } }
  if (!result.ok) return { ok: false, errors: [result.reason] }
  if (!result.changed) return { ok: true, applied: [], commit: null }
  logEvent({
    level: 'info',
    kind: 'policy',
    message: `settings changed: ${applied.join(', ')}`,
    detail: result.sha ? `committed ${result.sha}` : undefined,
  })
  return { ok: true, applied: [...applied], commit: result.sha }
}


function validate(def: SettingDef, value: string): string | null {
  switch (def.kind) {
    case 'enum':
      return def.options?.includes(value) ? null : `must be one of ${def.options?.join(', ')}`
    case 'bool':
      return value === 'true' || value === 'false' ? null : 'must be true or false'
    case 'int': {
      if (value === '' && def.optional) return null
      if (!/^\d+$/.test(value)) return 'must be a whole number'
      if (def.min !== undefined && Number(value) < def.min) return `must be at least ${def.min}`
      return null
    }
    case 'number': {
      if (!/^\d+(\.\d+)?$/.test(value)) return 'must be a number'
      if (def.min !== undefined && Number(value) < def.min) return `must be at least ${def.min}`
      return null
    }
    case 'cron':
      try {
        new Cron(value)
        return null
      } catch {
        return 'not a valid schedule expression'
      }
    case 'windows': {
      if (value === '') return null
      const bad = value
        .split(',')
        .map((w) => w.trim())
        .filter((w) => !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(w))
      return bad.length ? `not a valid window: ${bad[0]}` : null
    }
    case 'model':
      // A slash is legal: gateways namespace models by vendor (`anthropic/claude-opus-5`).
      return /^[A-Za-z0-9._/-]+$/.test(value) ? null : 'not a valid model id'
    default:
      return null
  }
}


function format(def: SettingDef, value: string): string {
  // An empty optional is the absence of a limit, and YAML says that with `null`. Not
  // an empty string: `max_open: ` parses as null too, but reads as an unfinished edit.
  if (value === '' && def.optional) return 'null'
  if (def.kind === 'windows') {
    const items = value
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean)
    return items.length ? `[${items.map((w) => `"${w}"`).join(', ')}]` : '[]'
  }
  // Quoted in the file today and worth keeping quoted: an unquoted cron expression is
  // legal YAML but reads badly and invites a parser surprise.
  if (def.kind === 'cron') return `"${value}"`
  return value
}
