import { parse as parseYaml } from 'yaml'
import { retiredKeys, validatePolicyText } from '../config.ts'
import { removeValue, setValue, spliceValue } from '../settings.ts'

/**
 * What it takes to bring a v1 compose repository up to date: the labels and policy keys
 * the pull-request era read, rewritten in the words shipshape reads now.
 *
 * Pure (no fs, no git, no database) and self-contained: the v1 meaning of each label is
 * frozen in the table below rather than borrowed from `classFor`, so this keeps working
 * after the code that once read those labels is gone. `src/bin/convert-v1.ts` is the
 * command that applies it.
 */

/** One label to set (`value`) or remove (`value: null`) on one service. */
export interface LabelEdit {
  file: string
  service: string
  key: string
  value: string | null
  /** What the service said before: `shipshape.<k>: <v>`, or `(none)` for a set of a new label. */
  was: string
}

/** One policy key to set to a YAML-formatted value, or to remove (`value: null`). */
export interface PolicyEdit {
  path: string
  value: string | null
  why: string
}

const clean = (v: string | undefined): string | null => {
  const s = v?.trim().toLowerCase()
  return s ? s : null
}

/** v1's `shipshape.policy` ladder, as `classFor` read it before v2. Anything else asked. */
const V1_POLICY: Record<string, string> = {
  auto: 'normal',
  attended: 'lifeline',
  'on-request': 'frozen',
}

export function planServiceLabels(file: string, service: string, labels: Record<string, string>): LabelEdit[] {
  const raw = (k: string): string | undefined => labels[`shipshape.${k}`]
  const policy = clean(raw('policy'))
  const pr = clean(raw('pr'))
  const hasPolicy = raw('policy') !== undefined
  const hasPr = raw('pr') !== undefined
  const hasClaude = raw('claude') !== undefined
  const hasClass = raw('class') !== undefined
  const hasReview = raw('review') !== undefined

  const edits: LabelEdit[] = []
  const set = (key: string, value: string) =>
    edits.push({ file, service, key, value, was: labels[key] === undefined ? '(none)' : `${key}: ${labels[key]}` })
  const remove = (k: string) => edits.push({ file, service, key: `shipshape.${k}`, value: null, was: `shipshape.${k}: ${raw(k)}` })

  // The class first. v1's `skip` beat a class; anything else lost to one.
  if (policy === 'skip') set('shipshape.class', 'skip')
  else if (hasPolicy && !hasClass) set('shipshape.class', (policy && V1_POLICY[policy]) ?? 'ask')
  else if (!hasPolicy && !hasClass && pr === 'on-request') set('shipshape.class', 'frozen')

  if (hasClaude && !hasReview) set('shipshape.review', raw('claude')!)

  if (hasPolicy) remove('policy')
  if (hasPr) remove('pr')
  if (hasClaude) remove('claude')
  return edits
}

const fmt = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v) : String(v))

type Doc = Record<string, Record<string, unknown> | undefined> & { paused?: unknown }

export function planPolicy(raw: string, opts: { notifyUrlSet: boolean }): PolicyEdit[] {
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const doc = parsed as Doc
  const at = (block: string): Record<string, unknown> | undefined => {
    const b = doc[block]
    return b && typeof b === 'object' && !Array.isArray(b) ? b : undefined
  }
  const claude = at('claude')
  const review = at('review')
  const merge = at('merge')
  const ship = at('ship')
  const notify = at('notify')
  const deploy = at('deploy')
  const propose = at('propose')

  const edits: PolicyEdit[] = []
  const set = (path: string, value: string, why: string) => edits.push({ path, value, why })

  // 1. claude -> review, key by key; review wins where it already says something.
  const claudeOff = claude?.mode === 'off' && review?.model === undefined
  for (const k of ['model', 'code_model', 'monthly_budget_usd']) {
    if (k === 'model' && claudeOff) continue
    if (claude?.[k] !== undefined && review?.[k] === undefined) set(`review.${k}`, fmt(claude[k]), `from claude.${k}`)
  }
  if (claudeOff) set('review.model', '"off"', 'from claude.mode')

  // 2. merge -> ship.
  for (const k of ['cooldown_days', 'max_per_run']) {
    if (merge?.[k] !== undefined && ship?.[k] === undefined) set(`ship.${k}`, fmt(merge[k]), `from merge.${k}`)
  }

  // 3. The old pair folded into paused: running unattended only when both said so.
  if (doc.paused === undefined && (merge !== undefined || deploy?.mode !== undefined)) {
    set('paused', String(!(merge?.auto === true && deploy?.mode === 'auto')), 'from merge.auto and deploy.mode')
  }

  // 4. notify.sinks used to be derived from incidents and email; write what that gave.
  if (notify?.sinks === undefined) {
    const inc = notify?.incidents
    const em = notify?.email
    const list: string[] = []
    if ((inc ?? 'alerts') !== 'off' && (inc ?? 'alerts') !== 'routine' && (inc !== undefined || opts.notifyUrlSet)) {
      list.push('{ type: webhook }')
    }
    if (em === 'alerts' || em === 'all') list.push('{ type: email }')
    if (list.length > 0 || inc !== undefined || em !== undefined) {
      set('notify.sinks', `[${list.join(', ')}]`, 'from notify.incidents and notify.email')
    }
  }

  // 5. The old spelling of the verify window won over the new one.
  if (deploy?.health_window_s !== undefined) {
    set('deploy.verify_window_s', fmt(deploy.health_window_s), 'from deploy.health_window_s')
  }

  // 6. manual meant what off means.
  if (propose?.mode === 'manual') set('propose.mode', 'off', 'manual meant off')

  // 7. Every retired key goes.
  for (const k of retiredKeys(raw)) edits.push({ path: k, value: null, why: 'retired' })
  return edits
}

export function applyPolicyEdits(
  raw: string,
  edits: PolicyEdit[],
): { ok: true; text: string } | { ok: false; reason: string } {
  let text = raw
  const ordered = [...edits.filter((e) => e.value !== null), ...edits.filter((e) => e.value === null)]
  for (const e of ordered) {
    const next =
      e.value === null
        ? removeValue(text, e.path)
        : e.path === 'paused'
          ? (spliceValue(text, 'paused', e.value) ?? underHeader(text, `paused: ${e.value}`))
          : setValue(text, e.path, e.value)
    if (next === null) return { ok: false, reason: `could not edit ${e.path} automatically; edit it by hand` }
    text = next
  }
  const left = retiredKeys(text)
  if (left.length > 0) return { ok: false, reason: `still carries ${left.join(', ')}; edit it by hand` }
  const valid = validatePolicyText(text)
  if (!valid.ok) return { ok: false, reason: valid.error }
  return { ok: true, text }
}

/** The one switch reads best at the top: after the header comment, before the first key. */
function underHeader(text: string, line: string): string {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && /^\s*(#.*)?$/.test(lines[i]!)) i++
  const header = lines.slice(0, i)
  while (header.length > 0 && header[header.length - 1]!.trim() === '') header.pop()
  const rest = lines.slice(i)
  const body = rest.join('\n').trim() === '' ? [''] : ['', ...rest]
  return [...header, ...(header.length > 0 ? [''] : []), line, ...body].join('\n')
}

export function describeLabelEdit(e: LabelEdit): string {
  return e.value === null ? `${e.service}: ${e.was} removed` : `${e.service}: ${e.was} -> ${e.key}: ${e.value}`
}

export function describePolicyEdit(e: PolicyEdit): string {
  return e.value === null ? `${e.path} removed  (${e.why})` : `${e.path}: ${e.value}  (${e.why})`
}
