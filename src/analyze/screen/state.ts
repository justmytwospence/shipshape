import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { NotesBundle } from '../../notes/assemble.ts'
import { versionKey, sameVersion } from '../../versions/key.ts'

/**
 * What the screen is shown: the update, how this deployment uses the service, and the
 * release notes for the range, filtered and capped in code.
 *
 * Jev is calibrated and literal, and its documented weak spots decide the shape here.
 * Large state full of irrelevant detail costs accuracy, so contributor lists, dependency
 * bump lines and collapsed blocks are removed before anything is sent, and the notes most
 * likely to matter go first. Numbers and dates are not its job, so which versions in the
 * range have no notes at all is worked out here rather than asked. And it does not write,
 * so instead of a summary it is given the notes' own bullet lines and asked about each --
 * the review then quotes the ones that matter, verbatim, with their links.
 *
 * Pure apart from reading compose files, so the rules are testable on their own.
 */

/** Per note, so one enormous release cannot crowd out the rest of the range. */
export const NOTE_CAP = 6_000
/** For everything together, comfortably inside Jev's per-request context. */
export const TOTAL_CAP = 40_000
/** Bullet lines the screen is asked about one by one. Two questions each. */
export const LINE_CAP = 60

/** Headings and text that usually carry the part worth reading. */
const PRIORITY = /break|upgrad|migrat|deprecat|remov|security|vulnerab|cve-/i

export interface ScreenNote {
  version: string
  source: 'release' | 'changelog' | 'linked'
  heading: string
  text: string
  /** Where a person reads this note upstream. */
  url: string | null
}

export interface ScreenLine {
  version: string
  text: string
  url: string | null
}

/** How one service carrying the update is configured -- names only, never values. */
export interface DeploymentEntry {
  service: string
  image: string | null
  environment: string[]
  volumes: string[]
  command: boolean
  depends_on: string[]
  healthcheck: boolean
}

export interface ScreenInput {
  update: {
    image: string
    from: string
    to: string
    magnitude: string
    /** Versions in the range that no fetched note describes. Computed here, never asked. */
    notes_missing_for: string[]
  }
  deployment: DeploymentEntry[]
  notes: { version: string; source: string; heading: string; text: string }[]
  lines: { version: string; text: string }[]
}

export interface BuiltState {
  state: ScreenInput
  /** The same lines with their links, in the order the questions refer to them. */
  lines: ScreenLine[]
  notes: ScreenNote[]
  /** Notes left out for length: the screen did not see the whole range. */
  omitted: string[]
  missing: string[]
  contextHash: string
}

/** Remove what is long and never decides anything: collapsed blocks, credits, bot lines. */
export function clean(text: string): string {
  return (
    text
      // GitHub returns many release bodies with CRLF line endings, and a `$` after `.+`
      // does not match before a `\r` -- so Jackett's notes yielded no bullet lines at all.
      .replace(/\r\n?/g, '\n')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<details[\s\S]*?<\/details>/gi, '')
      // A "New Contributors" or "Contributors" section, to the next heading or the end.
      .replace(/^#{1,6}\s*(new\s+)?contributors?\b[\s\S]*?(?=^#{1,6}\s|$(?![\s\S]))/gim, '')
      .split('\n')
      .filter(
        (l) =>
          !/\*\*full changelog\*\*|^\s*full changelog\b/i.test(l) &&
          !/\b(dependabot|renovate)(\[bot\])?\b/i.test(l) &&
          !/^\s*[-*+]\s*(chore\(deps\)|build\(deps\)|bump\s+\S+\s+from\s+\S+\s+to\s+\S+)/i.test(l) &&
          !/made their first contribution/i.test(l),
      )
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

function releaseUrl(repo: string | null, tag: string): string | null {
  return repo ? `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}` : null
}

/** Every note in the bundle, cleaned, as one list, newest first within each source. */
function collect(b: NotesBundle): ScreenNote[] {
  const repo = b.source.repo
  const out: ScreenNote[] = []
  for (const r of b.releases) {
    const text = clean(r.body)
    if (!text) continue
    out.push({
      version: r.tag,
      source: 'release',
      heading: r.name && r.name !== r.tag ? `${r.tag} — ${r.name}` : r.tag,
      text,
      url: releaseUrl(repo, r.tag),
    })
  }
  if (b.changelog) {
    const url = repo ? `https://github.com/${repo}/blob/HEAD/${b.changelog.file}` : null
    for (const s of b.changelog.sections) {
      const text = clean(s.body)
      if (text) out.push({ version: s.heading, source: 'changelog', heading: s.heading, text, url })
    }
  }
  if (b.external) {
    for (const s of b.external.sections) {
      const text = clean(s.body)
      if (text) out.push({ version: s.heading, source: 'linked', heading: s.heading, text, url: b.external.link })
    }
  }
  return out
}

/**
 * Which notes the screen sees, within the caps: the ones that look like they matter
 * first, then the rest in the order they came (newest first). What does not fit is named,
 * so a screen that did not see the whole range never reads as one that did.
 */
export function selectNotes(all: ScreenNote[]): { notes: ScreenNote[]; omitted: string[] } {
  const ordered = [
    ...all.filter((n) => PRIORITY.test(n.heading) || PRIORITY.test(n.text)),
    ...all.filter((n) => !(PRIORITY.test(n.heading) || PRIORITY.test(n.text))),
  ]
  const notes: ScreenNote[] = []
  const omitted: string[] = []
  let total = 0
  for (const n of ordered) {
    const text = n.text.length > NOTE_CAP ? `${n.text.slice(0, NOTE_CAP)}\n[cut for length]` : n.text
    if (total + text.length > TOTAL_CAP) {
      omitted.push(n.heading)
      continue
    }
    total += text.length
    notes.push({ ...n, text })
  }
  // Truncating a note is leaving part of it out.
  for (const n of ordered) if (n.text.length > NOTE_CAP && !omitted.includes(n.heading)) omitted.push(`${n.heading} (cut)`)
  return { notes, omitted }
}

/** The notes' own bullet lines, deduplicated, the likely-important ones first. */
export function extractLines(notes: ScreenNote[]): ScreenLine[] {
  const seen = new Set<string>()
  const lines: ScreenLine[] = []
  for (const n of notes) {
    for (const raw of n.text.split(/\r?\n/)) {
      const m = raw.match(/^\s*[-*+]\s+(.+)$/)
      if (!m) continue
      const text = m[1]!.replace(/\s+/g, ' ').trim()
      if (text.length < 8) continue
      const key = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
      if (seen.has(key)) continue
      seen.add(key)
      lines.push({ version: n.version, text: text.slice(0, 400), url: n.url })
    }
  }
  return [...lines.filter((l) => PRIORITY.test(l.text)), ...lines.filter((l) => !PRIORITY.test(l.text))].slice(0, LINE_CAP)
}

/**
 * Releases in the range with no words at all, and no changelog section for the same
 * version. A screen cannot judge what it was never shown, and an empty release body is
 * the common way a range quietly has a hole in it.
 */
export function missingVersions(b: NotesBundle): string[] {
  const covered = [
    ...(b.changelog?.sections ?? []).map((s) => s.key),
    ...(b.external?.sections ?? []).map((s) => s.key),
  ].filter((k) => k !== null)
  return b.releases
    .filter((r) => !clean(r.body))
    .filter((r) => {
      const k = r.key ?? versionKey(r.tag)
      return !k || !covered.some((c) => sameVersion(c!, k))
    })
    .map((r) => r.tag)
}

/** A service's block in its compose file, reduced to names. Values never leave this host. */
export function deploymentOf(repoDir: string, composeFile: string, service: string): DeploymentEntry | null {
  let doc: unknown
  try {
    doc = parseYaml(readFileSync(join(repoDir, composeFile), 'utf8'))
  } catch {
    return null
  }
  const services = (doc as { services?: Record<string, Record<string, unknown>> } | null)?.services
  const svc = services?.[service]
  if (!svc || typeof svc !== 'object') return null

  const env = svc.environment
  const environment = Array.isArray(env)
    ? env.filter((e): e is string => typeof e === 'string').map((e) => e.split('=')[0]!)
    : env && typeof env === 'object'
      ? Object.keys(env)
      : []
  const volumes = (Array.isArray(svc.volumes) ? svc.volumes : [])
    .map((v) => {
      if (typeof v === 'string') {
        const parts = v.split(':')
        return parts.length >= 2 ? parts[1]! : parts[0]!
      }
      return typeof (v as { target?: unknown })?.target === 'string' ? (v as { target: string }).target : null
    })
    .filter((v): v is string => !!v)
  const dependsRaw = svc.depends_on
  const dependsOn = Array.isArray(dependsRaw)
    ? dependsRaw.filter((d): d is string => typeof d === 'string')
    : dependsRaw && typeof dependsRaw === 'object'
      ? Object.keys(dependsRaw)
      : []
  return {
    service,
    image: typeof svc.image === 'string' ? svc.image : null,
    environment: [...new Set(environment)].sort(),
    volumes: [...new Set(volumes)].sort(),
    command: svc.command !== undefined || svc.entrypoint !== undefined,
    depends_on: dependsOn.map((d) => {
      const img = services?.[d]?.image
      return typeof img === 'string' ? `${d} (${img})` : d
    }),
    healthcheck: svc.healthcheck !== undefined,
  }
}

/** Stable across runs for the same configuration, so a change in it is what triggers a re-screen. */
export function contextHash(deployment: DeploymentEntry[]): string {
  const canonical = [...deployment].sort((a, b) => a.service.localeCompare(b.service))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16)
}

export function buildState(
  b: NotesBundle,
  update: { image: string; from: string; to: string; magnitude: string },
  deployment: DeploymentEntry[],
): BuiltState {
  const { notes, omitted } = selectNotes(collect(b))
  const lines = extractLines(notes)
  const missing = missingVersions(b)
  return {
    state: {
      update: { ...update, notes_missing_for: missing },
      deployment,
      notes: notes.map((n) => ({ version: n.version, source: n.source, heading: n.heading, text: n.text })),
      lines: lines.map((l) => ({ version: l.version, text: l.text })),
    },
    lines,
    notes,
    omitted,
    missing,
    contextHash: contextHash(deployment),
  }
}
