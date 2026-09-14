import { inRange, versionKey, type VersionKey } from '../versions/key.ts'

/**
 * A changelog file, cut into one section per version.
 *
 * Plenty of projects write their notes into a file rather than into GitHub releases, or
 * write both and keep the file more complete: minuspod publishes a release for a fraction
 * of its versions and a CHANGELOG.md entry for every one, so the review saw nothing for
 * 2.96.17 when its notes were a click away. The shapes vary more than the idea does --
 * `## [2.96.17] - 2026-09-10`, `## 2026-05-16 v4.0.1-rc.1`, an H1 per version wrapping a
 * compare link, an RST title underlined with `=` -- so a heading counts by what it names,
 * not by how it is written.
 *
 * The version level is the first heading level with at least two versioned headings: that
 * skips a lone `# Changelog` title and keeps `### Fixed` inside its version. A file with no
 * such level is not a changelog, whatever it is called: postgres's HISTORY is a pointer.
 */

export interface Section {
  heading: string
  key: VersionKey | null
  /** An `Unreleased` section: work not in any image yet. */
  unreleased: boolean
  body: string
}

export const SECTION_CAP = 20_000
export const TOTAL_CAP = 30_000

interface Heading {
  /** First line of the heading (the overline, for an RST overlined title). */
  start: number
  /** First line after it. */
  bodyStart: number
  level: string
  title: string
}

export function sectionize(
  text: string,
  o: { filename?: string; family?: VersionKey['family'] } = {},
): Section[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const atx = atxHeadings(lines)
  const headings = /\.rst$/i.test(o.filename ?? '') || atx.length === 0 ? rstHeadings(lines) : atx

  // Levels in rank order: ATX by depth, RST by first appearance, which is RST's own rule.
  const ranks: string[] = []
  for (const h of headings) if (!ranks.includes(h.level)) ranks.push(h.level)
  if (atx.length > 0 && headings === atx) ranks.sort()

  const versioned = (h: Heading) => {
    const v = headingVersion(h.title, o.family)
    return v.key !== null
  }
  const level = ranks.find((l) => headings.filter((h) => h.level === l && versioned(h)).length >= 2)
  if (level === undefined) return []
  const rank = ranks.indexOf(level)

  const sections: Section[] = []
  headings.forEach((h, i) => {
    if (h.level !== level) return
    // The body runs to the next heading at this level or above.
    const next = headings.slice(i + 1).find((n) => ranks.indexOf(n.level) <= rank)
    const body = lines.slice(h.bodyStart, next ? next.start : lines.length).join('\n').trim()
    const { key, unreleased } = headingVersion(h.title, o.family)
    // A title sharing the versions' style -- glances overlines "Glances ChangeLog" exactly as
    // it overlines each version -- is not a section. `Unreleased` is kept, and says so.
    if (!key && !unreleased) return
    sections.push({
      heading: h.title,
      key,
      unreleased,
      body: body.length > SECTION_CAP ? `${body.slice(0, SECTION_CAP)}\n[the rest of this section was cut]` : body,
    })
  })
  return sections
}

/**
 * The version a heading names. Link targets go first, so the compare URL in
 * `# [2.39.0](https://github.com/n8n-io/n8n/compare/n8n@2.38.1...n8n@2.39.0)` does not
 * offer 2.38.1. A date beside the version is a different family and loses to it.
 */
export function headingVersion(
  title: string,
  family?: VersionKey['family'],
): { key: VersionKey | null; unreleased: boolean } {
  if (/\bunreleased\b/i.test(title)) return { key: null, unreleased: true }
  const plain = title.replace(/\]\([^)]*\)/g, ']').replace(/<[^>]*>/g, ' ').replace(/[[\]()]/g, ' ')
  const keys = plain
    .split(/[\s,;]+/)
    .map((t) => t.replace(/^[^\w]+|[^\w]+$/g, ''))
    .filter(Boolean)
    .map((t) => versionKey(t))
    .filter((k): k is VersionKey => k !== null)
  const whole = keys.filter((k) => !k.partial)
  const pick =
    whole.find((k) => k.family === (family ?? 'semver')) ??
    whole.find((k) => k.family === 'semver') ??
    whole[0] ??
    null
  return { key: pick, unreleased: false }
}

/**
 * The sections for versions after `from`, up to and including `to`, in file order, within
 * the total cap. What the cap left out is named rather than silently dropped.
 */
export function sectionsInRange(
  sections: Section[],
  from: VersionKey | null,
  to: VersionKey,
  cap = TOTAL_CAP,
): { sections: Section[]; omitted: string[] } {
  const kept: Section[] = []
  const omitted: string[] = []
  let used = 0
  for (const s of sections) {
    if (!s.key || !inRange(s.key, from, to)) continue
    if (used + s.body.length > cap && kept.length > 0) {
      omitted.push(s.heading)
      continue
    }
    kept.push(s)
    used += s.body.length
  }
  return { sections: kept, omitted }
}

function atxHeadings(lines: string[]): Heading[] {
  const out: Heading[] = []
  let fence: string | null = null
  lines.forEach((line, i) => {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (f) {
      if (fence === null) fence = f[1]![0]!
      else if (f[1]![0] === fence) fence = null
      return
    }
    if (fence !== null) return
    const m = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) out.push({ start: i, bodyStart: i + 1, level: String(m[1]!.length), title: m[2]!.trim() })
  })
  return out
}

const ADORNMENT = /^([=\-~^"'`#*+_:.])\1{2,}\s*$/

function rstHeadings(lines: string[]): Heading[] {
  const out: Heading[] = []
  for (let i = 0; i + 1 < lines.length; i++) {
    const title = lines[i]!
    const under = ADORNMENT.exec(lines[i + 1]!)
    if (!under || !title.trim() || ADORNMENT.test(title)) continue
    if (under[0].trim().length < Math.min(title.trim().length, 3)) continue
    const over = i > 0 ? ADORNMENT.exec(lines[i - 1]!) : null
    const overlined = over !== null && over[1] === under[1]
    out.push({
      start: overlined ? i - 1 : i,
      bodyStart: i + 2,
      level: `${under[1]}${overlined ? 'o' : ''}`,
      title: title.trim(),
    })
    i++
  }
  return out
}

/** The version a per-version file is named for, from its name's tokens: grocy's `83_4.7.1_2026-09-04.md`. */
export function fileVersion(name: string, family: VersionKey['family']): VersionKey | null {
  const stem = name.replace(/\.(md|markdown|rst|txt|adoc)$/i, '')
  const keys = stem
    .split(/[_\s]+|-(?=v?\d)/)
    .map((t) => versionKey(t))
    .filter((k): k is VersionKey => !!k && !k.partial)
  return keys.find((k) => k.family === family) ?? null
}
