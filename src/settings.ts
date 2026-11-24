import { Cron } from 'croner'
import { DEFAULT_CODE_MODEL, DEFAULT_READER_MODEL, gitBranch, type Policy } from './config.ts'
import { logEvent } from './db.ts'
import { commitPolicyFile } from './gitops/policy-file.ts'

/**
 * Editing policy.yaml from the browser.
 *
 * Settings ARE policy.yaml -- there is no second store to drift out of step, and the
 * file stays the tracked, reviewable source of truth the rest of this repo expects.
 * Edits are line splices, never a re-serialisation: the file is written for humans and
 * carries a comment above almost every key explaining why it is set that way, all of
 * which a YAML emitter would discard.
 *
 * ## Why the splicer inserts as well as replaces
 *
 * It originally only replaced an existing line, and returned null -- "could not find X
 * in policy.yaml" -- for anything else. That looked safe and was not: every field on
 * the page is submitted on every save, so the first setting whose key had never been
 * written to the file failed the whole save, including the twenty-five that were fine.
 * A policy.yaml written before `merge`, `model_tier`, `claude.web` and
 * `claude.code_model` existed therefore made the entire Settings page inert, silently,
 * with no way to fix it from the page that was broken.
 *
 * The rule that fixes it is the same one that keeps the file legible: a key the schema
 * knows about is always addressable. Missing keys are inserted at the end of their
 * section, missing sections are appended, and everything already in the file keeps its
 * comments and its position.
 */

export type SettingKind =
  | 'enum'
  | 'int'
  | 'number'
  | 'bool'
  | 'string'
  | 'windows'
  | 'cron'
  | 'model'

export interface SettingDef {
  /** Dotted path, e.g. `claude.model` or `claude.web.searches`. Any depth. */
  path: string
  kind: SettingKind
  label: string
  /**
   * What you need in order to fill this in: a format, a unit, a prerequisite. A
   * fragment, not a sentence -- it sits under the control on every render, so anything
   * longer turns a form into an essay. Empty is fine and common.
   */
  help: string
  /** Why this exists and what it costs you. Lives in the (i), read once. */
  about?: string
  options?: string[]
  /** Plain-language gloss per option, shown as a legend under an enum. */
  optionHelp?: Record<string, string>
  min?: number
  /** Shown as "default: X" so a changed value is obvious. */
  defaultValue: string
  /**
   * What to call the default when the value itself is not worth showing. `max_open`
   * defaults to empty, and "default: " renders as a sentence that stops mid-word;
   * "default: unlimited" says the thing.
   */
  defaultLabel?: string
  /**
   * Blank is a legal value and means "no limit", written to the file as `null`. Only
   * for keys whose schema is genuinely nullable -- a blank on any other key is a typo
   * and must stay an error.
   */
  optional?: boolean
  /** Present = read-only, with the reason shown. */
  locked?: string
  section: SectionName
  /**
   * Tuning rather than policy: correct out of the box, folded away by default. The
   * distinction is whether getting it wrong changes *what shipshape may do* (never
   * advanced) or only how fast or how thoroughly it does it (advanced).
   */
  advanced?: boolean
}

/**
 * The sections, in the order the pipeline actually runs.
 *
 * Order used to fall out of whatever position a field happened to occupy in the array
 * below, which produced nine headings including both "Deploy" and "Deploys" as separate
 * sections holding the same setting twice. Naming the sequence here means the page reads
 * as the path an update takes -- found, judged, proposed, merged, deployed -- and a new
 * setting has one obvious home.
 *
 * That claim was false in two places until the Settings page started rendering this order
 * as an explanation, at which point it stopped being cosmetic. `scheduler.ts` runs
 * runPrPass -> runAnalysisPass -> runProposePass -> runAutoMerge, so: the pull request
 * exists before the model writes a verdict INTO it, and a proposal is drafted before the
 * merge it then forces to wait. Changelog review used to sit above Pull requests and
 * Merging above Drafted changes, which made the hand-off between sections unwritable.
 *
 * Reordering is free: pane ids are slugs of these NAMES, so no anchor or bookmark moves,
 * and applySettings iterates SETTINGS rather than this, so policy.yaml is untouched.
 */
export const SECTIONS = [
  // First, because it is the switch the whole model hangs on.
  ['Pause', 'The one switch: whether anything ships on its own.'],
  ['Scanning', 'When shipshape asks the registries what exists.'],
  [
    'Shipping',
    'An update ships on its own unless something concrete says a person is needed: the service always asks, the review found work or something unsafe, there is no evidence on a risky jump, or a one-way migration has no restore point. Which services ask is their `shipshape.class` label, not a setting here.',
  ],
  [
    'Changelog review',
    'A screen looks at every update; a reader reads the ones a person will. Either can hold an update for you — never cause one to ship.',
  ],
  [
    'Drafted changes',
    'When an update needs more than its tag, a model can write the rest onto a local branch. A change carrying drafted edits never ships on its own.',
  ],
  ['Restore points', 'A dump taken before a stateful service is updated, so a one-way migration can be undone by hand.'],
  ['Deploys', 'A change is done when it is running, not when it is shipped.'],
  [
    'Notifications',
    'Where decisions and failures go. Silence means healthy: nothing is announced on success.',
  ],
  ['Rules', 'Standing always-ship decisions, written by the Always ship button and kept in the policy file.'],
  ['Git sync', `Publishing ${gitBranch()}, and staying out of the way while you work.`],
] as const satisfies readonly (readonly [string, string])[]

export type SectionName = (typeof SECTIONS)[number][0]

export const SETTINGS: SettingDef[] = [
  // ------------------------------------------------------------ Finding updates
  {
    section: 'Scanning',
    path: 'scan.cron',
    kind: 'cron',
    defaultValue: '0 0 3 * * *',
    label: 'Schedule',
    help: 'Cron, seconds first',
    about:
      'Applies immediately — no restart needed.',
  },

  // ------------------------------------------------- What may happen without you
  {
    section: 'Shipping',
    path: 'ship.cooldown_days',
    kind: 'number',
    min: 0,
    defaultValue: '7',
    label: 'Cooldown',
    help: 'days a release must age',
    about:
      'Nothing ships on its own until its release is this old, so a broken or hijacked release has time to be noticed and pulled. A verified security fix waits `security.fix_cooldown_days` instead, and one you ship yourself does not wait.',
  },
  {
    section: 'Shipping',
    path: 'ship.max_per_run',
    advanced: true,
    kind: 'int',
    min: 1,
    defaultValue: '3',
    label: 'Max ships per run',
    help: '',
    about: 'A ceiling so a misconfiguration ships a couple of things rather than the backlog.',
  },

  // -------------------------------------------------------- Reading the changelog
  {
    section: 'Changelog review',
    path: 'review.screen',
    kind: 'enum',
    options: ['off', 'shadow', 'on'],
    optionHelp: {
      off: 'no screen; the reader reads every update',
      shadow: 'screen every update and show what it found, without acting on it',
      on: 'the screen decides which updates the reader is paid to read',
    },
    defaultValue: 'off',
    label: 'Screen',
    help: 'a fast classifier through OpenRouter (needs OPENROUTER_API_KEY), a fraction of a cent a look',
    about:
      'A fast model answers narrow questions about the release notes -- does a setting change, is there a manual step -- and picks the lines worth reading. It can hold an update back and never cause one.',
  },
  {
    section: 'Changelog review',
    path: 'review.model',
    advanced: true,
    kind: 'model',
    defaultValue: DEFAULT_READER_MODEL,
    defaultLabel: DEFAULT_READER_MODEL ? undefined : 'none -- a custom endpoint needs one set',
    label: 'Reader',
    help: DEFAULT_READER_MODEL
      ? 'reads the changelog where a person will read the result; off for none'
      : 'required with a custom endpoint (LLM_BASE_URL), which has no default; off for none',
    about:
      'Pick from the list, or type an id that is not on it.',
  },
  {
    section: 'Changelog review',
    path: 'review.web',
    advanced: true,
    kind: 'enum',
    options: ['auto', 'off'],
    optionHelp: {
      auto: 'the reader and the drafter may search and read github.com and the LinuxServer docs (never on a custom endpoint)',
      off: 'they read only what shipshape fetched',
    },
    defaultValue: 'auto',
    label: 'Web access',
    help: '',
    about:
      'Searches are billed per request, and fetched pages are most of what a reading costs. Off, a release with no notes in the range is judged on what shipshape fetched alone.',
  },
  {
    section: 'Changelog review',
    path: 'review.monthly_budget_usd',
    kind: 'number',
    min: 0.01,
    defaultValue: '15',
    label: 'Monthly budget',
    help: 'USD, every model call together',
    about:
      'Reaching it pauses the reader and drafting until the 1st of next month; updates keep shipping on the evidence that is left. Calls to a custom endpoint (LLM_BASE_URL) are not priced and never count against it. To spend nothing, set Reader to off.',
  },

  // ------------------------------------------------------- Drafting config changes
  {
    section: 'Drafted changes',
    path: 'propose.mode',
    advanced: false,
    kind: 'enum',
    options: ['auto', 'off'],
    optionHelp: {
      auto: 'draft whenever the review names steps this deployment has to take',
      off: 'only when you press Draft config changes on an update',
    },
    defaultValue: 'auto',
    label: 'Draft config changes',
    help: '',
    about:
      'A drafted change always waits for you to read it and press Ship, whatever else is set.',
  },
  {
    section: 'Drafted changes',
    path: 'review.code_model',
    advanced: true,
    kind: 'model',
    defaultValue: DEFAULT_CODE_MODEL,
    defaultLabel: DEFAULT_CODE_MODEL ? undefined : 'none -- a custom endpoint needs one set',
    label: 'Model',
    help: 'drafts config changes and picks the scope of an Always ship rule',
    about:
      'Rare, high-stakes work: a draft is a change nothing else has checked.',
  },

  {
    section: 'Pause',
    path: 'paused',
    kind: 'bool',
    defaultValue: 'true',
    label: 'Pause',
    help: 'nothing ships on its own',
    // The section's prose says the rest; this is the one line that changes with the switch.
    about:
      'Unpausing is how an update goes from detected to running without you -- when nothing holds it and its release has aged. Shipping one yourself still works while paused.',
  },
  // ------------------------------------------------------------- Restore points
  {
    section: 'Restore points',
    path: 'restore_points.keep',
    advanced: true,
    kind: 'int',
    min: 1,
    defaultValue: '3',
    label: 'Keep per service',
    help: 'dumps',
    about:
      'The newest few are kept under the data directory. The dump command is the service\'s own `shipshape.snapshot` label; an offsite copy is `restore_points.offsite` in the policy file.',
  },

  // ---------------------------------------------------------------- Deploying
  {
    section: 'Deploys',
    path: 'deploy.probe',
    advanced: true,
    kind: 'enum',
    options: ['auto', 'off'],
    optionHelp: {
      auto: 'ask the service over HTTP, on the port its Traefik router declares or shipshape.probe names',
      off: 'judge on container state alone',
    },
    defaultValue: 'auto',
    label: 'Probe over HTTP',
    help: '',
    about:
      'Many containers carry no healthcheck, but a service behind Traefik already declares the port it answers on, and shipshape.probe names one by hand. Anything below a 500 counts as answered -- a redirect to a login page is still a service that is listening. It can only ever warn, never fail a deploy by itself.',
  },
  {
    section: 'Deploys',
    path: 'deploy.rollback',
    advanced: false,
    kind: 'enum',
    options: ['auto', 'suggest', 'off'],
    optionHelp: {
      auto: 'put the previous version back, once, then tell you whatever happened',
      suggest: 'send the alert with the commands, and change nothing',
      off: 'never mention rolling back',
    },
    defaultValue: 'auto',
    label: 'When verification fails',
    help: '',
    about:
      `Exactly one attempt: a revert commit on ${gitBranch()}, deployed and announced. There is no second try and no setting that adds one. A change carrying more than an image line is never reverted unattended, and a verifier that could not see the containers never triggers anything -- both fall back to asking you.`,
  },
  {
    section: 'Deploys',
    path: 'deploy.verify_window_s',
    kind: 'int',
    min: 30,
    defaultValue: '300',
    label: 'Verify window',
    help: 'seconds',
    about:
      'How long a deploy has to prove itself. It returns the moment every signal is good, so only a bad deploy pays the wait -- which is what lets this be long enough for a service that runs migrations on first start.',
    advanced: true,
  },
  {
    section: 'Deploys',
    path: 'deploy.soak_s',
    kind: 'int',
    min: 0,
    defaultValue: '1800',
    label: 'Soak before verified',
    help: 'seconds; 0 to skip',
    about:
      'A second look this long after a deploy passes, because the failures a window catches are the fast ones. Only after this does an update read verified. Nothing is ever rolled back at this point -- by then real state has accrued, so undoing it is your call. A service left stopped is not soaked — nothing was brought up.',
    advanced: true,
  },

  // ------------------------------------------------------- Telling you about it
  {
    section: 'Notifications',
    path: 'notify.escalate_after_days',
    kind: 'int',
    min: 1,
    defaultValue: '7',
    label: 'Escalate a waiting decision after',
    help: 'days',
    about:
      'A decision card still open this long is announced once more, louder. Where cards go is `notify.sinks` in the policy file (webhook, email, ntfy, Discord, Gotify, Apprise).',
  },

  // -------------------------------------------------------- Keeping git in step
  {
    section: 'Git sync',
    path: 'sync.push_main',
    advanced: false,
    kind: 'bool',
    defaultValue: 'true',
    label: `Publish ${gitBranch()}`,
    help: '',
    about:
      'Required for shipping: a branch cut from a stale origin reverts unpushed work when merged. Off degrades shipshape to alert-only.',
  },
  {
    section: 'Git sync',
    path: 'sync.poll_active_s',
    kind: 'int',
    min: 15,
    defaultValue: '60',
    label: 'Poll, work in flight',
    help: 'seconds',
    about:
      'How often the loop runs while something is detected, shipping or deploying.',
    advanced: true,
  },
  {
    section: 'Git sync',
    path: 'sync.poll_idle_s',
    kind: 'int',
    min: 30,
    defaultValue: '600',
    label: 'Poll, idle',
    help: 'seconds',
    about:
      'How often the loop runs when nothing is in flight.',
    advanced: true,
  },
]

export function currentValue(policy: Policy, path: string): string {
  const raw = path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], policy)
  if (Array.isArray(raw)) return raw.join(', ')
  return raw === undefined || raw === null ? '' : String(raw)
}

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

// Exported under fuller names so the rules themselves are testable: both are pure, and
// the alternative -- reaching them through applySettings -- drags in the filesystem and
// a git commit to assert on a string.
export { validate as validateSetting, format as formatSetting }

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
      return /^[A-Za-z0-9._\/-]+$/.test(value) ? null : 'not a valid model id'
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

/**
 * Set one key's value, leaving every other byte of structure and commentary alone.
 *
 * Works at any depth, and creates what is missing. Three cases, in order:
 *
 *   1. the key is already there  -> its value is replaced, trailing comment kept
 *   2. its parent block is there -> the key is inserted at the end of that block
 *   3. nothing is there          -> the block, and the key, are appended
 *
 * Cases 2 and 3 are why this exists at all: without them, a key the schema knows about
 * but the file has never mentioned is permanently unreachable from the UI, and since
 * every field is submitted on every save, one such key disables the whole page.
 *
 * Returns null only when the path itself is unusable (empty, or an empty segment).
 */
export function setValue(text: string, path: string, formatted: string): string | null {
  const parts = path.split('.')
  if (parts.length === 0 || parts.some((p) => p === '')) return null

  const replaced = spliceValue(text, path, formatted)
  if (replaced !== null) return replaced
  return insertValue(text, parts, formatted)
}

/**
 * Replace an existing key, or null when it is not in the file.
 *
 * Each segment narrows the search to its parent's block, which is what disambiguates
 * identically-named keys: `mode` exists under `claude`, `propose`, `deploy` and
 * `model_tier`, and only the enclosing range tells them apart.
 */
export function spliceValue(text: string, path: string, formatted: string): string | null {
  const lines = text.split('\n')
  const found = locate(lines, path.split('.'))
  if (!found) return null

  const m = new RegExp(`^([ \\t]*${escapeRe(found.key)}:[ \\t]*)(.*)$`).exec(lines[found.line]!)
  if (!m) return null
  // Preserve any trailing comment on the same line.
  const trailing = /(\s+#.*)$/.exec(m[2]!)?.[1] ?? ''
  lines[found.line] = `${m[1]}${formatted}${trailing}`
  return lines.join('\n')
}

/**
 * Remove a key and everything nested under it, with the comment lines directly above it
 * at the same indent (they describe the key). A parent left with no keys goes too.
 * Returns the text unchanged when the key is absent, null when the path is unusable.
 *
 * A run of comments that reaches the top of the file is the file's header, not the key's
 * description, so it stays.
 */
export function removeValue(text: string, path: string): string | null {
  const parts = path.split('.')
  if (parts.length === 0 || parts.some((p) => p === '')) return null

  const lines = text.split('\n')
  const found = locate(lines, parts)
  if (!found) return text

  const depth = parts.length - 1
  const end = Math.max(found.line + 1, backUpOverBlanks(lines, blockEnd(lines, found.line, depth)))
  const comment = new RegExp(`^${'  '.repeat(depth)}#`)
  let start = found.line
  while (start > 0 && comment.test(lines[start - 1]!)) start--
  if (start === 0) start = found.line

  lines.splice(start, end - start)
  // Removing a block that had a blank line on each side would leave two in a row.
  if (start > 0 && start < lines.length && lines[start - 1]!.trim() === '' && lines[start]!.trim() === '') {
    lines.splice(start, 1)
  }
  const out = lines.join('\n')
  if (parts.length === 1) return out

  const parent = parts.slice(0, -1)
  const after = out.split('\n')
  const p = locate(after, parent)
  if (!p) return out
  if (!/:\s*(#.*)?$/.test(after[p.line]!)) return out
  const stop = blockEnd(after, p.line, depth - 1)
  for (let i = p.line + 1; i < stop; i++) {
    const l = after[i]!.trim()
    if (l !== '' && !l.startsWith('#')) return out
  }
  return removeValue(out, parent.join('.'))
}

/** Where a dotted path's final key sits, or null when any segment is absent. */
function locate(
  lines: string[],
  parts: string[],
): { line: number; key: string; indent: string } | null {
  let from = 0
  let to = lines.length
  let depth = 0

  for (let p = 0; p < parts.length; p++) {
    const key = parts[p]!
    const indent = '  '.repeat(depth)
    const re = new RegExp(`^${indent}${escapeRe(key)}:([ \\t]|$)`)
    let hit = -1
    for (let i = from; i < to; i++) {
      if (re.test(lines[i]!)) {
        hit = i
        break
      }
    }
    if (hit === -1) return null
    if (p === parts.length - 1) return { line: hit, key, indent }
    from = hit + 1
    to = blockEnd(lines, hit, depth)
    depth++
  }
  return null
}

/** The first line at or above `depth` after `start` -- i.e. where that block stops. */
function blockEnd(lines: string[], start: number, depth: number): number {
  const want = depth * 2
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (l.trim() === '') continue
    const indent = /^[ \t]*/.exec(l)![0].length
    // A comment at the parent's own indent belongs to whatever comes next, not to this
    // block -- stopping before it keeps an inserted key above the next section's header
    // comment rather than orphaning it below.
    if (indent <= want) return i
  }
  return lines.length
}

/**
 * Insert a key that is not in the file yet, creating any parent blocks it needs.
 *
 * Appended at the end of the deepest parent that does exist, so an insertion never
 * lands between a comment and the key that comment describes.
 */
function insertValue(text: string, parts: string[], formatted: string): string {
  const lines = text.split('\n')

  // How much of the path already exists?
  let from = 0
  let to = lines.length
  let depth = 0
  let insertAt = lines.length
  let matched = 0

  for (const key of parts.slice(0, -1)) {
    const re = new RegExp(`^${'  '.repeat(depth)}${escapeRe(key)}:([ \\t]|$)`)
    let hit = -1
    for (let i = from; i < to; i++) {
      if (re.test(lines[i]!)) {
        hit = i
        break
      }
    }
    if (hit === -1) break
    matched++
    from = hit + 1
    to = blockEnd(lines, hit, depth)
    insertAt = to
    depth++
  }

  // For a top-level key with no parents, append at the end of the document.
  if (parts.length === 1) insertAt = trailingBlank(lines)
  else if (matched === 0) insertAt = trailingBlank(lines)
  else insertAt = backUpOverBlanks(lines, insertAt)

  const block: string[] = []
  // Nesting depth is path depth, so segment `p` always sits at `p` levels of indent.
  for (let p = matched; p < parts.length - 1; p++) {
    block.push(`${'  '.repeat(p)}${parts[p]}:`)
  }
  const leafIndent = '  '.repeat(parts.length - 1)
  block.push(`${leafIndent}${parts[parts.length - 1]}: ${formatted}`)

  // A brand-new top-level block reads better with a blank line above it.
  if (matched === 0 && parts.length > 1) block.unshift('')

  lines.splice(insertAt, 0, ...block)
  return lines.join('\n')
}

/** Index of the first trailing blank line, so an append does not add to the gap. */
function trailingBlank(lines: string[]): number {
  let i = lines.length
  while (i > 0 && lines[i - 1]!.trim() === '') i--
  return i
}

/** Step back over blank lines so an insertion hugs the block it belongs to. */
function backUpOverBlanks(lines: string[], at: number): number {
  let i = at
  while (i > 0 && lines[i - 1]!.trim() === '') i--
  return i
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
