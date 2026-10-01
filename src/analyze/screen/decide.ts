import type { Answer, Question } from '../jev.ts'

/**
 * What the screen asks, and what the answers decide.
 *
 * The wording follows Jev's documented behaviour: it reads literally, so each question
 * asks one property in plain words and names the part of the state it is about; its
 * criteria say the same thing as its instruction rather than something adjacent; and
 * nothing asks it to count, compare versions or write. All of that is code's job, below.
 *
 * The decision is deliberately lopsided. `routine` -- the one outcome that lets an update
 * through without a reader -- needs every risk question to be a clear no, the evidence to
 * be complete, and the update to be a patch or minor. Anything doubtful goes to the
 * reader. The thresholds are constants, not settings: they are calibrated against
 * recorded reviews (`npm run jev-replay`), and a slider would invite moving them without
 * that.
 */

const noul = (instructions: string, yes: string, no: string): Question => ({
  type: 'noul',
  instructions,
  criteria: { true: yes, false: no },
})

/** The questions that hold an update back. Each is a separate, literal property. */
export const RISK_KEYS = [
  'config_removed_or_renamed',
  'manual_step_required',
  'irreversible_migration',
  'dropped_support',
  'default_changed',
  'config_change_needed',
] as const

export type RiskKey = (typeof RISK_KEYS)[number]

const UPDATE_QUESTIONS: Record<string, Question> = {
  config_removed_or_renamed: noul(
    'Do the release notes in `notes` say that an existing configuration option, environment variable, command-line flag, or file path was removed, renamed, or now behaves differently?',
    'An existing option, variable, flag, or path is removed, renamed, or changes meaning',
    'No existing option, variable, flag, or path changes. Newly added optional settings do not count',
  ),
  manual_step_required: noul(
    'Do the release notes in `notes` tell the person upgrading to do something besides pulling the new image and restarting it?',
    'The notes name an action: edit configuration, run a command or migration, change a dependency, or back up data first',
    'Pulling the new image and restarting is all the notes ask for',
  ),
  irreversible_migration: noul(
    'Do the release notes in `notes` describe a data or database migration that cannot be undone, or say that going back to the previous version afterwards is not supported?',
    'A one-way migration, or downgrading is said to be unsupported',
    'No one-way migration and nothing said against downgrading',
  ),
  dropped_support: noul(
    'Do the release notes in `notes` say that support was dropped for a platform, CPU architecture, runtime version, database version, or integration?',
    'Something that used to be supported no longer is',
    'Nothing that was supported is dropped',
  ),
  default_changed: noul(
    'Do the release notes in `notes` say that a default value or default behaviour changed, in a way that applies without anyone changing their configuration?',
    'A default changed and applies to existing installations',
    'No default changed, or only for new installations',
  ),
  config_change_needed: noul(
    "Do the release notes in `notes` require editing the service's configuration -- environment variables, command, volumes, or configuration files -- for it to keep working after the upgrade?",
    'A configuration edit is required to keep the service working',
    'No configuration edit is required. Steps that are not configuration edits do not count',
  ),
  affects_this_deployment: noul(
    'Does a change described in `notes` apply to something listed in `deployment` -- one of its environment variable names, volume paths, its command, or a service it depends on?',
    'A change in `notes` names or clearly applies to an item listed in `deployment`',
    'No change in `notes` touches anything listed in `deployment`',
  ),
  security_fix: noul(
    'Do the release notes in `notes` describe a fix for a security vulnerability?',
    'A security vulnerability is fixed',
    'No security fix is described',
  ),
  risk: {
    type: 'score',
    instructions:
      'How risky is it to apply this update to a deployment like `deployment` without reading `notes` first?',
    criteria: [
      'Routine: nothing in the notes needs attention before upgrading',
      'Worth reading first: a default, a behaviour, or an optional setting changed',
      'Breaks without action: something this deployment relies on is removed, renamed, or must be migrated',
    ],
  },
}

/** Every question for one update: the update-wide ones, and two per bullet line. */
export function questionsFor(lineCount: number): Record<string, Question> {
  const q: Record<string, Question> = { ...UPDATE_QUESTIONS }
  for (let i = 0; i < lineCount; i++) {
    q[`L${i}_actionable`] = noul(
      `Does the release note line \`lines[${i}].text\` tell the operator to change something or take an action when upgrading?`,
      'The line asks for, or plainly implies, an action when upgrading',
      'The line only describes a fix, a feature, or an internal change',
    )
    q[`L${i}_notable`] = noul(
      `Would a user of this service notice the change described in \`lines[${i}].text\` without changing any configuration?`,
      'A visible change in behaviour, interface, or performance',
      'Internal, cosmetic, or only of interest to developers',
    )
  }
  return q
}

// --------------------------------------------------------------------- deciding

export interface Thresholds {
  /** Every risk question must be below this for `routine`. */
  routineRisk: number
  /** `affects_this_deployment` must be below this for `routine`. */
  routineAffects: number
  /** `risk.score` (0..2) must be below this for `routine`. */
  routineScore: number
  /** ...and the Score's own confidence at least this. */
  routineScoreConfidence: number
  /** Any risk question at or above this is a finding. */
  findingRisk: number
  /** `risk.score` at or above this is a finding. */
  findingScore: number
  /** A line at or above this is actionable. */
  lineActionable: number
  /** A line at or above this is notable. */
  lineNotable: number
}

/**
 * Starting points, set conservatively before any calibration. Phase 3 of the rollout may
 * loosen the routine ones -- only where `npm run jev-replay` shows no miss -- and never
 * tighten a finding into something quieter.
 */
export const THRESHOLDS: Thresholds = {
  routineRisk: 0.2,
  routineAffects: 0.3,
  routineScore: 0.5,
  routineScoreConfidence: 0.75,
  findingRisk: 0.5,
  findingScore: 1.0,
  lineActionable: 0.6,
  lineNotable: 0.6,
}

export type ScreenDecision = 'routine' | 'finding' | 'escalate' | 'no-notes'

export interface ScreenEvidence {
  magnitude: string
  notesInRange: number
  incomplete: boolean
  approximate: boolean
  missing: number
  omitted: number
  /** How the upstream was identified: high confidence, or a label the operator set. */
  sourceCertain: boolean
}

export interface ScreenFlags {
  risk: Record<RiskKey, number>
  affects: number
  security: number
  score: number
  scoreConfidence: number
}

export interface ScreenResult {
  decision: ScreenDecision
  /** Why, in a sentence: the first thing that kept it from being routine, or why it is. */
  reason: string
  flags: ScreenFlags | null
  /** Indices into the lines the screen was shown. */
  actionable: number[]
  notable: number[]
  /** What a routine result's approval is worth. */
  confidence: 'high' | 'medium' | null
}

function noulOf(a: Record<string, Answer>, k: string): number {
  const v = a[k]
  return v?.type === 'noul' ? v.noul : 1
}

export function flagsOf(answers: Record<string, Answer>): ScreenFlags {
  const r = answers.risk
  const score = r?.type === 'score' ? r : null
  return {
    risk: Object.fromEntries(RISK_KEYS.map((k) => [k, noulOf(answers, k)])) as Record<RiskKey, number>,
    affects: noulOf(answers, 'affects_this_deployment'),
    security: noulOf(answers, 'security_fix'),
    // A missing Score reads as the riskiest answer, not the safest.
    score: score?.score ?? 2,
    scoreConfidence: score?.confidence ?? 0,
  }
}

const LABEL: Record<RiskKey, string> = {
  config_removed_or_renamed: 'a setting removed or renamed',
  manual_step_required: 'a manual step',
  irreversible_migration: 'a one-way migration',
  dropped_support: 'dropped support',
  default_changed: 'a changed default',
  config_change_needed: 'a configuration edit',
}

/**
 * The screen's verdict from its answers and the evidence code already holds.
 *
 * Order matters: what the evidence rules out is decided before anything Jev said, so a
 * confident answer about notes that were never complete cannot read as routine.
 */
export function decideScreen(
  e: ScreenEvidence,
  answers: Record<string, Answer> | null,
  lineCount: number,
  t: Thresholds = THRESHOLDS,
): ScreenResult {
  if (e.notesInRange === 0 || !answers) {
    return { decision: 'no-notes', reason: 'no release notes were found for this range', flags: null, actionable: [], notable: [], confidence: null }
  }
  const flags = flagsOf(answers)
  const actionable: number[] = []
  const notable: number[] = []
  for (let i = 0; i < lineCount; i++) {
    if (noulOf(answers, `L${i}_actionable`) >= t.lineActionable) actionable.push(i)
    else if (noulOf(answers, `L${i}_notable`) >= t.lineNotable) notable.push(i)
  }
  const base = { flags, actionable, notable }

  const found = RISK_KEYS.filter((k) => flags.risk[k] >= t.findingRisk)
  if (found.length > 0) {
    return { ...base, decision: 'finding', reason: `the notes mention ${found.map((k) => LABEL[k]).join(', ')}`, confidence: null }
  }
  if (flags.score >= t.findingScore) {
    return { ...base, decision: 'finding', reason: 'the notes read as worth a look before upgrading', confidence: null }
  }

  // What would make a routine answer untrustworthy, whatever Jev said.
  const why =
    e.magnitude !== 'patch' && e.magnitude !== 'minor'
      ? `a ${e.magnitude} update always gets a full reading`
      : e.incomplete
        ? 'some notes could not be fetched'
        : e.approximate
          ? 'the version range is approximate'
          : e.missing > 0
            ? `${e.missing} version(s) in the range have no notes`
            : e.omitted > 0
              ? 'some notes were left out for length'
              : !e.sourceCertain
                ? 'the upstream project is a likely match, not a certain one'
                : null
  if (why) return { ...base, decision: 'escalate', reason: why, confidence: null }

  const clear =
    RISK_KEYS.every((k) => flags.risk[k] < t.routineRisk) &&
    flags.affects < t.routineAffects &&
    flags.score < t.routineScore &&
    flags.scoreConfidence >= t.routineScoreConfidence
  if (!clear) {
    return { ...base, decision: 'escalate', reason: 'the screen was not sure enough to call it routine', confidence: null }
  }
  return {
    ...base,
    decision: 'routine',
    reason: 'no required changes identified in the fetched release notes',
    confidence: flags.scoreConfidence >= 0.9 ? 'high' : 'medium',
  }
}
