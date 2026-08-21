import { getDb } from './db.ts'

/**
 * Which updates must land in the same pull request.
 *
 * Immich pins immich-server and immich-machine-learning at the same version and does
 * not support running them skewed. If each got its own PR, merging one without the
 * other would leave the stack broken until someone noticed. The same shape applies to
 * any daemon/server or frontend/backend pair released in lockstep, and to two containers
 * sharing one image.
 *
 * This is deliberately not a dependency engine -- it is four known pairs and a rule
 * that catches them.
 */

export interface GroupMember {
  id: number
  stack: string
  service: string
  image: string
  from_tag: string
  to_tag: string
  magnitude: string
  tier: string
}

export interface UpdateGroup {
  /** null for a singleton; otherwise the branch-safe group identity. */
  key: string | null
  /**
   * The same identity without the target tag, or null for a singleton.
   *
   * The two differ in exactly one way and it is load-bearing. `key` decides what travels
   * together, so it carries the target tag: two services drifting to different versions
   * must never share a commit. The branch name must not carry it -- a name that changed
   * with the target could never be reused, and that is precisely what forced an overtaken
   * pull request to be closed and replaced instead of retargeted.
   */
  branchKey: string | null
  members: GroupMember[]
}

/**
 * Group by (stack, shared identity, target tag). Two identities count:
 *
 *   A. the same resolved upstream source repo -- immich-server and
 *      immich-machine-learning both resolve to immich-app/immich;
 *   B. an explicit `shipshape.group` label, for pairs whose annotations resolve
 *      differently or not at all.
 *
 * The target tag must match in both cases. Members drifting to different versions are
 * NOT grouped: bumping two services to mismatched versions in one commit would be a
 * worse failure than the skew this prevents.
 */
export function groupUpdates(
  pending: GroupMember[],
  sourceRepoFor: (stack: string, service: string) => string | null,
  groupLabelFor: (stack: string, service: string) => string | null,
): UpdateGroup[] {
  const buckets = new Map<string, GroupMember[]>()
  const singletons: UpdateGroup[] = []

  for (const m of pending) {
    const label = groupLabelFor(m.stack, m.service)
    const source = sourceRepoFor(m.stack, m.service)
    const identity = label ?? source
    if (!identity) {
      singletons.push({ key: null, branchKey: null, members: [m] })
      continue
    }
    const key = `${m.stack}|${label ? `label:${label}` : `src:${identity}`}|${m.to_tag}`
    const arr = buckets.get(key) ?? []
    arr.push(m)
    buckets.set(key, arr)
  }

  const out: UpdateGroup[] = [...singletons]
  for (const [key, members] of buckets) {
    if (members.length === 1) {
      // Sharing a source repo with nothing else is just a singleton.
      out.push({ key: null, branchKey: null, members })
      continue
    }
    const [stack, identity, tag] = key.split('|') as [string, string, string]
    const short = identity.replace(/^(label|src):/, '').split('/').pop() ?? 'group'
    const branchKey = `${stack}--group-${sanitise(short)}`
    out.push({ key: `${branchKey}--${sanitise(tag)}`, branchKey, members })
  }

  // Deterministic order so branch creation and tests are stable.
  out.sort((a, b) => firstId(a) - firstId(b))
  return out
}

function firstId(g: UpdateGroup): number {
  return Math.min(...g.members.map((m) => m.id))
}

/**
 * Branch-safe fragment. Digest refs collapse to 12 hex -- a full sha256 in a branch
 * name is unreadable and pushes past sane length limits.
 */
export function sanitise(s: string): string {
  return s
    .replace(/@sha256:([0-9a-f]{12})[0-9a-f]*/g, '@$1')
    .replace(/\//g, '-')
    .replace(/[^A-Za-z0-9._@-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Branch name for a group or singleton -- deliberately without the target tag.
 *
 * The name identifies the *service*, not the version it is being moved to, so when a
 * target is overtaken the successor wants the branch the open pull request already sits
 * on and can be retargeted onto it in place. GitHub cannot change a pull request's head
 * branch, so this naming is the whole reason retargeting is possible rather than closing
 * one pull request and opening another.
 *
 * Safe because at most one live update exists per (stack, service): every scan path that
 * records a new target first supersedes the live rows for that service, and eligibility
 * excludes updates already attached to an open pull request. Two shipshape pull requests
 * can therefore never both want this name. For the one case where a stale one lingers on
 * it -- a branch someone has pushed to, left open on purpose -- `resolveBranch` in pr.ts
 * falls back to `taggedBranchFor` rather than contending for it.
 */
export function branchFor(g: UpdateGroup): string {
  if (g.branchKey) return `shipshape/${g.branchKey}`
  const m = g.members[0]!
  return `shipshape/${m.stack}--${sanitise(m.service)}`
}

/**
 * The tag-suffixed form: unique per target, and therefore never reusable.
 *
 * This was the only naming scheme before retargeting existed, which is why every pull
 * request open at the time of that change migrates itself once -- its branch matches no
 * successor's name, so it takes the close-and-replace path a final time. It survives as
 * the fallback for the two pull requests that genuinely have to coexist on one service.
 */
export function taggedBranchFor(g: UpdateGroup): string {
  return `${branchFor(g)}--${sanitise(g.members[0]!.to_tag)}`
}

/** Lookup helpers backed by the resolution cache plus the live compose labels. */
export function makeLookups(services: { stack: string; service: string; groupLabel: string | null }[]): {
  sourceRepoFor: (stack: string, service: string) => string | null
  groupLabelFor: (stack: string, service: string) => string | null
} {
  const rows = getDb()
    .prepare(
      `SELECT i.stack, i.service, i.repository, r.source_url
       FROM images i LEFT JOIN resolutions r
         ON r.registry = i.registry AND r.repository = i.repository`,
    )
    .all() as { stack: string; service: string; repository: string; source_url: string | null }[]

  const bySvc = new Map(rows.map((r) => [`${r.stack}/${r.service}`, r]))
  const labels = new Map(services.map((s) => [`${s.stack}/${s.service}`, s.groupLabel]))
  return {
    sourceRepoFor: (stack, service) => {
      const r = bySvc.get(`${stack}/${service}`)
      // Fall back to the repository path itself: n8n and n8n-import share one image,
      // which is the same identity even before any resolution exists.
      return r?.source_url ?? r?.repository ?? null
    },
    groupLabelFor: (stack, service) => labels.get(`${stack}/${service}`) ?? null,
  }
}
