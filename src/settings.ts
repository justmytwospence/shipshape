import { readFileSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Cron } from 'croner'
import { botIdentity, env, paths, validatePolicyText, type Policy } from './config.ts'
import { logEvent } from './db.ts'

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
 * Merging above Config proposals, which made the hand-off between sections unwritable.
 *
 * Reordering is free: pane ids are slugs of these NAMES, so no anchor or bookmark moves,
 * and applySettings iterates SETTINGS rather than this, so policy.yaml is untouched.
 */
export const SECTIONS = [
  // First, because it is the switch the whole model hangs on. It lived under "Merging"
  // for a while, which was wrong twice over: it governs deploys as well, and it sat
  // halfway down a long page, so the banner that says "Paused -- Change" landed you at
  // the top of Settings with no sign of where to go.
  ['Pause', 'The one switch: whether anything happens without you.'],
  ['Scanning', 'When shipshape asks the registries what exists.'],
  [
    'Update policy',
    'How much happens without you, by how large the version jump is. A per-service `shipshape.policy` label overrides it. Majors are never on the auto rung.',
  ],
  ['Pull requests', 'Every change goes through one. It is the review surface.'],
  [
    'Changelog review',
    'A model finds and reads the release notes, then judges the update. Its verdict can only ever withhold a merge — never cause one.',
  ],
  [
    'Config proposals',
    'When an update needs more than its tag, a model can write the rest. A pull request carrying drafted changes can never merge automatically.',
  ],
  ['Merging', 'The only place shipshape changes the repository with nobody watching.'],
  ['Deploys', 'A change is done when it is running, not when it is merged.'],
  [
    'Notifications',
    'Routine outcomes only — opened, merged, deployed, drafted, held. Failures and anything that leaves shipshape stuck always send immediately and are not configurable here, so a digest can never cause you to miss one.',
  ],
  ['Git sync', 'Publishing main, and staying out of the way while you work.'],
] as const satisfies readonly (readonly [string, string])[]

export type SectionName = (typeof SECTIONS)[number][0]

/**
 * What a delivery channel receives. Stated per channel rather than as two lists of
 * channels, because the question an operator actually has is "what does my phone buzz
 * for" -- and the useful answer is often not the same for both.
 */
const CHANNEL_HELP: Record<string, string> = {
  all: 'everything: failures as they happen, and the routine digest',
  alerts: 'only what went wrong — a failed deploy, an unhealthy service, a stuck sync',
  routine: 'only the digest of what shipshape did as intended',
  off: 'nothing at all',
}

/** Plain-language gloss for the one enum that carries the whole model. */
const TIER_HELP: Record<string, string> = {
  auto: 'shipshape opens a pull request and merges it, unless the changelog review says otherwise',
  manual: 'shipshape opens a pull request; you merge it',
  'on-request': 'nothing is opened — the update is listed on the dashboard until you ask for a pull request',
  skip: 'not tracked at all',
}

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
    section: 'Update policy',
    path: 'defaults.patch',
    kind: 'enum',
    options: ['auto', 'manual', 'on-request', 'skip'],
    optionHelp: TIER_HELP,
    defaultValue: 'auto',
    label: 'Patch',
    help: 'x.y.Z',
    about:
      'The smallest jump upstream offers.',
  },
  {
    section: 'Update policy',
    path: 'defaults.minor',
    kind: 'enum',
    options: ['auto', 'manual', 'on-request', 'skip'],
    optionHelp: TIER_HELP,
    defaultValue: 'auto',
    label: 'Minor',
    help: 'x.Y.z',
    about:
      'New features, no promised breakage.',
  },
  {
    section: 'Update policy',
    path: 'defaults.major',
    kind: 'enum',
    options: ['manual'],
    defaultValue: 'manual',
    label: 'Major',
    help: 'X.y.z',
    about: 'Always a pull request you merge yourself.',
    locked: 'X.y.z — not configurable, a major always needs a human',
  },
  {
    section: 'Update policy',
    path: 'defaults.digest',
    kind: 'enum',
    options: ['auto', 'manual', 'on-request', 'skip'],
    optionHelp: TIER_HELP,
    defaultValue: 'manual',
    label: 'Digest',
    help: 'same tag, rebuilt',
    about:
      'A pinned sha256 moved. There is no changelog to read for one.',
  },

  // ------------------------------------------------------------- Pull requests
  {
    section: 'Pull requests',
    path: 'prs.enabled',
    advanced: true,
    kind: 'bool',
    defaultValue: 'true',
    label: 'Open pull requests',
    help: '',
    about:
      'Off keeps detection running but stops all pushing and PR creation.',
  },
  {
    section: 'Pull requests',
    path: 'prs.scope',
    advanced: true,
    kind: 'enum',
    options: ['coexist', 'full'],
    optionHelp: {
      coexist: 'take only what another updater leaves alone — majors, digest pins, and anything off the auto rung',
      full: 'shipshape is the only updater; it handles everything',
    },
    defaultValue: 'coexist',
    label: 'Coverage',
    help: '',
    about:
      'Coexist exists so two updaters can never write to the same file for the same reason.',
  },
  {
    section: 'Pull requests',
    path: 'prs.max_open',
    advanced: true,
    kind: 'int',
    min: 1,
    optional: true,
    defaultValue: '',
    defaultLabel: 'unlimited',
    label: 'Max open at once',
    help: 'blank for no limit',
    about:
      'Blank opens everything eligible at once. A number holds the rest back until an open one merges or closes -- which keeps the list short, at the cost of a full queue being silent: five stale pull requests once held fifteen updates shut for six days.',
  },
  {
    section: 'Pull requests',
    path: 'merge_method',
    kind: 'enum',
    options: ['squash', 'merge', 'rebase'],
    defaultValue: 'squash',
    label: 'Merge method',
    help: '',
    about:
      'Must be one the GitHub repository actually allows, or merging fails with a 405.',
    advanced: true,
  },

  // -------------------------------------------------------- Reading the changelog
  {
    section: 'Changelog review',
    path: 'claude.mode',
    kind: 'enum',
    options: ['advisory', 'off'],
    optionHelp: {
      advisory: 'read every update and let the verdict hold back an automatic merge',
      off: 'do not read anything; the ladder above decides on its own',
    },
    defaultValue: 'advisory',
    label: 'Mode',
    help: '',
    about:
      'Advisory lets a verdict hold back an automatic merge. It can never cause one.',
  },
  {
    section: 'Changelog review',
    path: 'claude.model',
    advanced: true,
    kind: 'model',
    defaultValue: 'claude-haiku-4-5-20251001',
    label: 'Model',
    help: 'runs on every update',
    about:
      'The one worth keeping cheap. Pick from the list, or type an id that is not on it.',
  },
  {
    section: 'Changelog review',
    path: 'claude.min_confidence',
    advanced: true,
    kind: 'enum',
    options: ['low', 'medium', 'high'],
    defaultValue: 'medium',
    label: 'Minimum confidence',
    help: '',
    about:
      'An approval below this is treated as a caution and waits for you.',
  },
  {
    section: 'Changelog review',
    path: 'claude.block_on',
    kind: 'string',
    defaultValue: 'block, caution',
    label: 'Hold on',
    help: '',
    about:
      'Which verdicts hold back an automatic merge.',
    locked: 'the damper is load-bearing; edit policy.yaml directly to change it',
  },
  {
    section: 'Changelog review',
    path: 'claude.monthly_budget_usd',
    kind: 'number',
    min: 0,
    defaultValue: '10',
    label: 'Monthly budget',
    help: 'USD',
    about:
      'Reaching it pauses analysis. Pull requests keep opening regardless.',
  },
  {
    section: 'Changelog review',
    path: 'claude.web.searches',
    kind: 'int',
    min: 1,
    defaultValue: '4',
    label: 'Searches per call',
    help: '',
    about:
      'How many web searches a single review or draft may run.',
    advanced: true,
  },
  {
    section: 'Changelog review',
    path: 'claude.web.fetches',
    kind: 'int',
    min: 1,
    defaultValue: '5',
    label: 'Pages per call',
    help: '',
    about:
      'With the size cap below, this sets the ceiling on what a call costs.',
    advanced: true,
  },
  {
    section: 'Changelog review',
    path: 'claude.web.content_tokens',
    kind: 'int',
    min: 1000,
    defaultValue: '12000',
    label: 'Tokens per page',
    help: '',
    about:
      'Reading is the dominant cost: worst case per call is pages × this.',
    advanced: true,
  },

  // ------------------------------------------------------- Drafting config changes
  {
    section: 'Config proposals',
    path: 'propose.mode',
    advanced: true,
    kind: 'enum',
    options: ['auto', 'manual', 'off'],
    optionHelp: {
      auto: 'draft whenever a verdict reports breakage or manual steps',
      manual: 'only when you press the button on a pull request',
      off: 'never draft anything',
    },
    defaultValue: 'auto',
    label: 'Draft config changes',
    help: '',
    about:
      'A drafted pull request always needs a human, whatever else is set.',
  },
  {
    section: 'Config proposals',
    path: 'claude.code_model',
    advanced: true,
    kind: 'model',
    defaultValue: 'claude-opus-5',
    label: 'Model',
    help: 'rare, high-stakes',
    about:
      'Worth a stronger model than the changelog verdicts use.',
  },

  // ------------------------------------------------------------------ Merging
  {
    section: 'Pause',
    path: 'paused',
    kind: 'bool',
    defaultValue: 'true',
    label: 'Pause',
    help: 'nothing merges or deploys on its own',
    // The section's prose says the rest; this is the one line that changes with the switch.
    about:
      'Unpausing is how an update goes from detected to running without you -- on the auto rung only, tag-only, patch or minor, with no verdict withholding it.',
  },
  {
    section: 'Merging',
    path: 'merge.max_per_run',
    advanced: true,
    kind: 'int',
    min: 1,
    defaultValue: '3',
    label: 'Max merges per run',
    help: '',
    about:
      'A ceiling so a misconfiguration merges a couple of things rather than the backlog.',
  },
  {
    section: 'Merging',
    path: 'model_tier.mode',
    advanced: true,
    kind: 'enum',
    options: ['off', 'shadow', 'enforce'],
    optionHelp: {
      off: 'ignore the label; those services fall back to a human',
      shadow: 'record what it would have decided, act on none of it',
      enforce: 'let a passing assessment move the update onto the auto rung',
    },
    defaultValue: 'shadow',
    label: 'Model-decided updates',
    help: 'shipshape.policy: model',
    about:
      'The one place a model can raise a rung rather than only lower it. The track record is on the System page.',
  },

  // ---------------------------------------------------------------- Deploying
  {
    section: 'Deploys',
    path: 'deploy.probe',
    advanced: true,
    kind: 'enum',
    options: ['auto', 'off'],
    optionHelp: {
      auto: 'ask the service over HTTP, on the port it already declares to traefik',
      off: 'judge on container state alone',
    },
    defaultValue: 'auto',
    label: 'Probe over HTTP',
    help: '',
    about:
      'Barely half the containers here carry a healthcheck, and 76 services already tell traefik which port they answer on. Anything below a 500 counts as answered -- a redirect to a login page is still a service that is listening. It can only ever warn, never fail a deploy by itself.',
  },
  {
    section: 'Deploys',
    path: 'deploy.rollback',
    advanced: true,
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
      'Exactly one attempt: a revert commit on main, deployed and announced. There is no second try and no setting that adds one. A pull request carrying more than an image line is never reverted unattended, and a verifier that could not see the containers never triggers anything -- both fall back to asking you.',
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
      'A second look this long after a deploy passes, because the failures a window catches are the fast ones. Only after this does an update read verified. Nothing is ever rolled back at this point -- by then real state has accrued, so undoing it is your call.',
    advanced: true,
  },

  // ------------------------------------------------------- Telling you about it
  {
    section: 'Notifications',
    path: 'notify.routine',
    kind: 'enum',
    options: ['digest', 'immediate', 'off'],
    optionHelp: {
      digest: 'collect them and send one message per batch',
      immediate: 'one push the moment each thing happens',
      off: 'record them in the activity log and push nothing',
    },
    defaultValue: 'digest',
    label: 'Routine outcomes',
    help: '',
    about:
      'A dozen separate pushes is a stream nobody reads; the same dozen in one message is a summary.',
  },
  {
    section: 'Notifications',
    path: 'notify.cron',
    kind: 'cron',
    defaultValue: '0 0 8 * * *',
    label: 'Digest schedule',
    help: 'Cron, seconds first',
    about:
      'Nothing is sent when nothing happened. Applies immediately.',
  },
  {
    section: 'Notifications',
    path: 'notify.ntfy',
    kind: 'enum',
    options: ['all', 'alerts', 'routine', 'off'],
    optionHelp: CHANNEL_HELP,
    defaultValue: 'all',
    label: 'Push (ntfy)',
    help: 'needs NTFY_TOKEN',
    about:
      'Nothing reaches a channel that is not configured, whatever this says.',
  },
  {
    section: 'Notifications',
    path: 'notify.email',
    kind: 'enum',
    options: ['all', 'alerts', 'routine', 'off'],
    optionHelp: CHANNEL_HELP,
    defaultValue: 'all',
    label: 'Email',
    help: 'needs SMTP_URL, MAIL_TO',
    about:
      'Emailed digests carry a link per item, which a push cannot.',
  },

  // -------------------------------------------------------- Keeping git in step
  {
    section: 'Git sync',
    path: 'sync.push_main',
    advanced: true,
    kind: 'bool',
    defaultValue: 'true',
    label: 'Publish main',
    help: '',
    about:
      'Required for pull requests: a branch cut from a stale origin reverts unpushed work when merged. Off degrades shipshape to alert-only.',
  },
  {
    section: 'Git sync',
    path: 'sync.blackout',
    kind: 'windows',
    defaultValue: '(none)',
    label: 'Blackout windows',
    help: 'HH:MM-HH:MM, comma-separated',
    about:
      'No git or deploy work happens inside them.',
  },
  {
    section: 'Git sync',
    path: 'sync.poll_active_s',
    kind: 'int',
    min: 15,
    defaultValue: '60',
    label: 'Poll, PRs open',
    help: 'seconds',
    about:
      'How often GitHub is checked while something is awaiting merge.',
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
      'How often GitHub is checked when nothing is open.',
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
  | { ok: false; errors: string[] }

export function applySettings(changes: Record<string, string>): ApplyResult {
  const file = paths.policy
  // Git wants the path relative to the repository root, wherever policy.yaml lives.
  const rel = relative(env.repoDir, file)
  let original: string
  try {
    original = readFileSync(file, 'utf8')
  } catch (err) {
    return { ok: false, errors: [`cannot read policy.yaml: ${(err as Error).message}`] }
  }

  // Never fold a browser edit into hand-edits sitting in the working tree -- the commit
  // would carry changes nobody reviewed here.
  const dirty = gitOut(['diff', '--name-only', '--', rel])
  if (dirty) {
    return {
      ok: false,
      errors: [
        'policy.yaml has uncommitted changes in the checkout. Commit or discard them first.',
      ],
    }
  }

  const errors: string[] = []
  const applied: string[] = []
  let text = original

  for (const [path, rawValue] of Object.entries(changes)) {
    const def = SETTINGS.find((s) => s.path === path)
    if (!def || def.locked) continue

    const value = rawValue.trim()
    const validation = validate(def, value)
    if (validation) {
      errors.push(`${def.label}: ${validation}`)
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

  if (errors.length > 0) return { ok: false, errors }
  if (applied.length === 0) return { ok: true, applied: [], commit: null }

  // A malformed file must never reach disk in a state the app would then fail to load.
  const check = validatePolicyText(text)
  if (!check.ok) return { ok: false, errors: [check.error] }

  writeFileSync(file, text)
  try {
    execFileSync('git', ['add', '--', rel], { cwd: env.repoDir })
    execFileSync(
      'git',
      [
        ...botIdentity(),
        'commit',
        '-m',
        `chore(shipshape): settings: ${applied.join(', ')}`,
        '--',
        rel,
      ],
      { cwd: env.repoDir },
    )
  } catch (err) {
    writeFileSync(file, original)
    execFileSync('git', ['checkout', '--', rel], { cwd: env.repoDir })
    return { ok: false, errors: [`could not commit the change: ${(err as Error).message}`] }
  }

  const sha = gitOut(['rev-parse', '--short', 'HEAD'])
  logEvent({
    level: 'info',
    kind: 'policy',
    message: `settings changed: ${applied.join(', ')}`,
    detail: sha ? `committed ${sha}` : undefined,
  })
  return { ok: true, applied, commit: sha }
}

function gitOut(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: env.repoDir, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
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
      return /^[A-Za-z0-9._-]+$/.test(value) ? null : 'not a valid model id'
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
