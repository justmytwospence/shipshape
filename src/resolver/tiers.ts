import { getRepo, rawFile } from '../upstream/github.ts'
import { registryDescription } from '../upstream/registries.ts'
import {
  buildFileUpstream,
  githubMentions,
  imageParts,
  isPackagingRepo,
  looksInherited,
  nameRelation,
  ownerRelation,
  rankMentions,
  relation,
  type RankedMention,
} from './guards.ts'
import { parseSourceLabel, sameRepo } from './labels.ts'
import type { ImageKey, ResolutionEvidence, SourceConfidence, ResolutionTier, Lookup } from './types.ts'
import { OVERRIDES } from './overrides.ts'
import { lsioProjects } from './lsio.ts'
import { type ManifestSources, walkManifest } from './manifest.ts'

interface Candidate {
  tier: ResolutionTier
  repo: string
  confidence: 'high' | 'medium'
  detail: string
  /** An annotation or LinuxServer names the repository the image is built from, fork or not. */
  allowFork?: boolean
}

/** One lookup's working state: what each tier proposed, and what became of it. */
class Run {
  readonly evidence: ResolutionEvidence = { candidates: [], skipped: [], billedPending: false }
  readonly failures: string[] = []
  readonly found: Candidate[] = []
  packagingRepo: string | null = null
  noneDetail: string | null = null
  skippedBilled = false

  constructor(readonly image: ImageKey) {}

  note(c: { tier: ResolutionTier; repo: string }, confidence: SourceConfidence | null, why: string): void {
    this.evidence.candidates.push({ tier: c.tier, repo: c.repo, confidence, why })
  }

  packaging(tier: ResolutionTier, repo: string): void {
    this.packagingRepo ??= repo
    this.note({ tier, repo }, null, 'a packaging repository: container changes, not the application')
  }

  /** The repository as GitHub names it now, or null when it is not one to believe. */
  async verify(c: Candidate): Promise<string | null> {
    if (isPackagingRepo(c.repo)) {
      this.packaging(c.tier, c.repo)
      return null
    }
    const r = await getRepo(c.repo)
    if (!r.ok) {
      this.failures.push(r.detail)
      this.note(c, null, `could not be checked: ${r.detail}`)
      return null
    }
    if (!r.data) {
      this.note(c, null, 'GitHub has no such repository')
      return null
    }
    const repo = r.data.fullName
    if (isPackagingRepo(repo)) {
      this.packaging(c.tier, repo)
      return null
    }
    if (r.data.fork && !c.allowFork && !ownerRelation(this.image.repository, repo)) {
      this.note({ ...c, repo }, null, `a fork of ${r.data.parent ?? 'another repository'}`)
      return null
    }
    return repo
  }

  /** Record a checked candidate. True when it settles the answer. */
  accept(c: Candidate, why = c.detail): boolean {
    this.found.push(c)
    this.note(c, c.confidence, why)
    return c.confidence === 'high'
  }

  async offer(c: Candidate): Promise<boolean> {
    const repo = await this.verify(c)
    return repo ? this.accept({ ...c, repo }) : false
  }

  result(): Lookup {
    let pick = this.found.find((f) => f.confidence === 'high')
    if (!pick) {
      // Two tiers arriving at the same repository independently corroborate each other.
      for (const f of this.found) {
        const other = this.found.find((g) => g.tier !== f.tier && sameRepo(g.repo, f.repo))
        if (other) {
          pick = { ...f, confidence: 'high', detail: `${f.detail}; also ${other.detail}` }
          break
        }
      }
    }
    pick ??= this.found[0]
    const certain = pick?.confidence === 'high'
    if (!certain && this.skippedBilled) this.evidence.billedPending = true
    return {
      repo: pick?.repo ?? null,
      tier: pick?.tier ?? 'none',
      confidence: pick?.confidence ?? null,
      detail: pick?.detail ?? this.noneDetail,
      packagingRepo: this.packagingRepo,
      failure: certain || this.failures.length === 0 ? null : [...new Set(this.failures)].join('; '),
      evidence: this.evidence,
    }
  }
}

/**
 * Look an image up, without writing anything. `resolve-report --dry-run` calls this directly.
 */
export async function lookUpImage(
  image: ImageKey,
  tag: string | null,
  o: { allowBilled?: boolean; ignoreOverrides?: boolean } = {},
): Promise<Lookup> {
  const run = new Run(image)
  try {
    await tiers(run, image, tag, { allowBilled: o.allowBilled ?? true, ignoreOverrides: !!o.ignoreOverrides })
  } catch (err) {
    // Each tier handles the failures it expects. Anything else is still a failure to look,
    // never evidence that there is nothing to find.
    run.failures.push((err as Error).message)
  }
  return run.result()
}

/** Code-hosting registries: their images' projects live there, not on GitHub. */
const FORGES = new Set(['codeberg.org', 'registry.gitlab.com', 'ghcr.io'])

async function tiers(
  run: Run,
  image: ImageKey,
  tag: string | null,
  o: { allowBilled: boolean; ignoreOverrides: boolean },
): Promise<void> {
  const override = o.ignoreOverrides ? undefined : OVERRIDES[`${image.registry}/${image.repository}`]
  if (override) {
    run.accept({ tier: 'override', repo: override, confidence: 'high', detail: "shipshape's curated map" })
    return
  }

  if (image.repository.startsWith('linuxserver/')) return linuxServer(run, image)

  // The manifest walk is the most authoritative thing there is, and free -- except on Docker
  // Hub, where it costs pulls, so there the free tiers go first.
  const hub = image.registry === 'docker.io'
  let walk: Walked | null = null
  if (!hub) {
    walk = await walkTier(run, image, tag, o.allowBilled)
    if (walk.settled) return
  }

  if (image.registry === 'ghcr.io') {
    const [owner, name] = image.repository.split('/')
    if (owner && name) {
      const settled = await run.offer({
        tier: 'ghcr-path',
        repo: `${owner}/${name}`,
        confidence: 'high',
        detail: 'published under the same path on ghcr.io',
      })
      if (settled) return
    }
  }

  if (await descriptionTier(run, image)) return

  if (hub) {
    walk = await walkTier(run, image, tag, o.allowBilled)
    if (walk.settled) return
  }
  if (walk?.label && (await configLabelTier(run, image, tag, walk.label))) return

  // A GitHub repository with the image's own owner and name is likely the source, and only
  // likely: plenty of Docker Hub namespaces belong to someone else on GitHub.
  const { namespace, names } = imageParts(image.repository)
  const guess = namespace && names[0] ? parseSourceLabel(`${namespace}/${names[0]}`) : null
  if (!FORGES.has(image.registry) && guess?.ok) {
    await run.offer({
      tier: 'lookup',
      repo: guess.repo,
      confidence: 'medium',
      detail: "a GitHub repository with the image's owner and name",
    })
  }
}

/**
 * LinuxServer images: their API, then their build file. Nothing else is asked -- every other
 * tier would find `linuxserver/docker-<app>`, which is the packaging, not the application.
 */
async function linuxServer(run: Run, image: ImageKey): Promise<void> {
  const name = image.repository.slice('linuxserver/'.length)
  const packaging = `linuxserver/docker-${name}`
  run.packagingRepo = packaging

  const api = await lsioProjects()
  if (!api.ok) {
    // A failure, not a fall-through: caching the packaging repo as the answer is exactly the
    // mistake these tiers exist to avoid.
    run.failures.push(api.error)
    return
  }
  const entry = api.projects.get(name)
  if (entry?.repo) {
    const settled = await run.offer({
      tier: 'lsio',
      repo: entry.repo,
      confidence: 'high',
      detail: "LinuxServer's API names it as the project",
      allowFork: true,
    })
    if (settled) return
  }

  const build = await rawFile(packaging, 'Jenkinsfile')
  if (!build.ok && build.kind !== 'not-found') {
    run.failures.push(build.detail)
    return
  }
  const named = build.ok ? buildFileUpstream(build.text) : null
  if (named) {
    // A build file reads its version from somewhere, and not always the application:
    // qbittorrent's reads userdocs/qbittorrent-nox-static, which distributes static binaries.
    // A repository named for the image is its source; any other is only likely.
    const settled = await run.offer({
      tier: 'lsio-build',
      repo: named,
      confidence: relation(name, named.split('/')[1] ?? '') === 'same' ? 'high' : 'medium',
      detail: `${packaging} builds from its releases`,
      allowFork: true,
    })
    if (settled) return
  }
  run.noneDetail = entry?.home
    ? `LinuxServer names ${entry.home} as its home, and its build file names no GitHub repository`
    : "LinuxServer's API and build file name no GitHub repository"
}

interface Walked {
  settled: boolean
  label: { repo: string; labels: Record<string, string> } | null
}

async function walkTier(run: Run, image: ImageKey, tag: string | null, allowBilled: boolean): Promise<Walked> {
  const nothing: Walked = { settled: false, label: null }
  if (!tag) {
    run.evidence.skipped.push('the manifest walk: no tag to read')
    return nothing
  }
  if (image.registry === 'docker.io' && !allowBilled) {
    run.evidence.skipped.push('the manifest walk, which Docker Hub counts as pulls')
    run.skippedBilled = true
    return nothing
  }
  let sources: ManifestSources
  try {
    sources = await walkManifest(image.registry, image.repository, tag)
  } catch (err) {
    // A budget stop, a 429, a timeout, a dropped connection: a failure to look.
    run.failures.push((err as Error).message)
    return nothing
  }
  if (sources.annotation) {
    const settled = await run.offer({
      tier: 'annotation',
      repo: sources.annotation,
      confidence: 'high',
      detail: "the image's OCI source annotation",
      allowFork: true,
    })
    if (settled) return { settled, label: null }
  }
  return { settled: false, label: sources.label }
}

async function descriptionTier(run: Run, image: ImageKey): Promise<boolean> {
  const d = await registryDescription(image)
  if (!d.ok) {
    run.failures.push(d.error)
    return false
  }
  if (!d.text) return false
  const { ranked, packaging } = rankMentions(image.repository, githubMentions(d.text))
  for (const p of packaging) run.packaging('description', p)

  for (const group of byScore(ranked)) {
    const checked: { c: Candidate; why: string }[] = []
    for (const m of group.slice(0, 3)) {
      const c: Candidate = {
        tier: 'description',
        repo: m.repo,
        confidence: m.confidence,
        detail: `linked from its description on ${d.where}`,
      }
      const repo = await run.verify(c)
      if (repo && !checked.some((v) => sameRepo(v.c.repo, repo))) checked.push({ c: { ...c, repo }, why: m.why })
    }
    if (checked.length === 1) return run.accept(checked[0]!.c, checked[0]!.why)
    if (checked.length > 1) {
      // Equally good links are ambiguity, not an answer, and a weaker link is no tiebreaker.
      for (const v of checked) {
        const others = checked.filter((x) => x !== v).map((x) => x.c.repo)
        run.note(v.c, null, `linked alongside ${others.join(', ')}, with nothing to say which is the source`)
      }
      return false
    }
  }
  return false
}

function byScore(ranked: RankedMention[]): RankedMention[][] {
  const groups: RankedMention[][] = []
  for (const m of ranked) {
    const last = groups[groups.length - 1]
    if (last && last[0]!.score === m.score) last.push(m)
    else groups.push([m])
  }
  return groups
}

async function configLabelTier(
  run: Run,
  image: ImageKey,
  tag: string | null,
  label: { repo: string; labels: Record<string, string> },
): Promise<boolean> {
  const c: Candidate = {
    tier: 'annotation',
    repo: label.repo,
    confidence: 'medium',
    detail: "the image's source label",
    allowFork: true,
  }
  const inherited = looksInherited(label.labels, image.repository, tag, label.repo)
  if (inherited) {
    run.note(c, null, `probably inherited from a base image: ${inherited}`)
    return false
  }
  const repo = await run.verify(c)
  if (!repo) return false
  const related = !!nameRelation(image.repository, repo) || !!ownerRelation(image.repository, repo)
  return run.accept({ ...c, repo, confidence: related ? 'high' : 'medium' })
}
