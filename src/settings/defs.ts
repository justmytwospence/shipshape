import { DEFAULT_CODE_MODEL, DEFAULT_READER_MODEL, type Policy } from '../policy-schema.ts'
import { gitBranch } from '../env.ts'

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
