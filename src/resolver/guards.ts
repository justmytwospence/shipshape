import { parseSourceLabel } from './labels.ts'
import { sameVersion, versionKey, type VersionKey } from '../versions/key.ts'

/**
 * The judgement calls the resolver makes about a candidate repository, kept apart from the
 * fetching so each can be tested on strings alone.
 */

/**
 * A packaging repository builds and publishes someone else's application:
 * `linuxserver/docker-code-server` packages coder/code-server, `docker-library/postgres`
 * packages PostgreSQL. Its releases are container builds, and its prerelease flags mark
 * packaging branches (`develop-*`), not the application's betas -- so neither says anything
 * about the application's own release stream.
 *
 * Narrow on purpose. `pi-hole/docker-pi-hole` and `crazy-max/docker-fail2ban` look like
 * packaging repos by name and are not: the image versions are theirs.
 */
export function isPackagingRepo(repo: string | null | undefined): boolean {
  if (!repo) return false
  return /^linuxserver\/docker-/i.test(repo) || /^docker-library\//i.test(repo) || /-library-image$/i.test(repo)
}

// ------------------------------------------------------------------ how names relate

export type Relation = 'same' | 'close' | null

/** Words too generic to tie an image to a repository on their own: `server` is in half of them. */
const GENERIC = new Set([
  'agent', 'api', 'app', 'backend', 'base', 'build', 'client', 'community', 'container', 'core',
  'daemon', 'docker', 'frontend', 'image', 'latest', 'main', 'official', 'release', 'server',
  'service', 'stable', 'web',
])

/** Lower case, packaging words and punctuation gone: `crazy-max` and `crazymax` are one owner,
 *  `docker-fail2ban` and `fail2ban` one project. */
function stem(s: string): string {
  return s
    .toLowerCase()
    .replace(/^docker[-_.]|[-_.]docker$|[-_.](image|container)$/g, '')
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Whether two names are the same name, or one plainly contains the other. Containment needs
 * four characters and a word that means something, so `n8n` is not inside `n8n-hosting` and
 * `server` is not inside everything.
 */
export function relation(a: string, b: string): Relation {
  const x = stem(a)
  const y = stem(b)
  if (!x || !y) return null
  if (x === y) return 'same'
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  if (short.length < 4 || GENERIC.has(short)) return null
  return long.includes(short) ? 'close' : null
}

/** An image path's namespace, and the segments after it that can name the project. */
export function imageParts(repository: string): { namespace: string | null; names: string[] } {
  const segs = repository.split('/').filter(Boolean)
  if (segs.length < 2) return { namespace: null, names: segs }
  // Docker Official Images live under `library`, which is nobody's GitHub account.
  return { namespace: segs[0] === 'library' ? null : segs[0]!, names: segs.slice(1) }
}

const better = (a: Relation, b: Relation): Relation => (a === 'same' || b === 'same' ? 'same' : a ?? b)

/**
 * How the repository's name relates to the image's name: any segment after the namespace,
 * or failing that the namespace itself, which is often the project -- `vaultwarden/server`
 * is dani-garcia/vaultwarden. The namespace only ever counts as close, so an image's own name
 * still outranks it.
 */
export function nameRelation(repository: string, repo: string): Relation {
  const name = repo.split('/')[1] ?? ''
  const { namespace, names } = imageParts(repository)
  const direct = names.reduce<Relation>((r, n) => better(r, relation(n, name)), null)
  if (direct || !namespace) return direct
  return relation(namespace, name) ? 'close' : null
}

/** How the repository's owner relates to the image's namespace: `n8nio` is `n8n-io`. */
export function ownerRelation(repository: string, repo: string): Relation {
  const { namespace } = imageParts(repository)
  const owner = repo.split('/')[0] ?? ''
  return namespace ? relation(namespace, owner) : null
}

// ------------------------------------------------------------------ descriptions

/** Accounts a description links for reasons that have nothing to do with the image's source. */
const NOT_PROJECTS = new Set([
  'about', 'actions', 'apps', 'badges', 'codespaces', 'collections', 'contact', 'dependabot',
  'docker', 'docker-library', 'enterprise', 'explore', 'features', 'github', 'issues', 'join',
  'login', 'marketplace', 'moby', 'new', 'notifications', 'orgs', 'organizations', 'pricing',
  'pulls', 'readme', 'renovatebot', 'search', 'security', 'settings', 'site', 'sponsors',
  'topics', 'trending', 'user-attachments', 'users',
])

// Not preceded by a dot, so api.github.com and gist.github.com never match.
const GITHUB_MENTION =
  /(?<![\w.@-])(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})/gi

/** Every GitHub repository a piece of prose links, first spelling kept, in order of appearance. */
export function githubMentions(text: string): string[] {
  const seen = new Map<string, string>()
  for (const m of text.matchAll(GITHUB_MENTION)) {
    const owner = m[1]!
    const name = m[2]!.replace(/\.git$/i, '').replace(/\.+$/, '')
    if (!name || NOT_PROJECTS.has(owner.toLowerCase())) continue
    const repo = `${owner}/${name}`
    if (!seen.has(repo.toLowerCase())) seen.set(repo.toLowerCase(), repo)
  }
  return [...seen.values()]
}

export interface RankedMention {
  repo: string
  confidence: 'high' | 'medium'
  score: number
  why: string
}

/**
 * The repositories a description links, best first, with how sure each would be.
 *
 * A description links plenty that is not the image's source -- the hosting guide, a
 * dependency, the Whisper model it runs -- so a link counts only by how it relates to the
 * image: name and owner both is `high`, one of them `medium`, neither is dropped. The caller
 * takes the unique best; two at the same score is ambiguity, not an answer.
 */
export function rankMentions(
  repository: string,
  mentions: string[],
): { ranked: RankedMention[]; packaging: string[] } {
  const ranked: RankedMention[] = []
  const packaging: string[] = []
  const points = (r: Relation) => (r === 'same' ? 2 : r ? 1 : 0)
  // An Official Image's page links the repository that packages it -- nginx/docker-nginx,
  // MariaDB/mariadb-docker, redis/docker-library-redis -- beside, or instead of, the
  // application's own. There, a repository named with "docker" is the packaging.
  const official = imageParts(repository).namespace === null
  for (const repo of mentions) {
    if (isPackagingRepo(repo) || (official && /(^|[-_.])docker([-_.]|$)/i.test(repo.split('/')[1] ?? ''))) {
      // Recorded only when it packages this image: postgres's page links postgis's too.
      if (nameRelation(repository, repo)) packaging.push(repo)
      continue
    }
    const name = nameRelation(repository, repo)
    const owner = ownerRelation(repository, repo)
    if (!name && !owner) continue
    const both = !!name && !!owner
    ranked.push({
      repo,
      confidence: both ? 'high' : 'medium',
      // Name and owner together outrank either; a name outranks an owner, which only says
      // "the same organisation".
      score: both ? 10 + points(name) + points(owner) : name ? 5 + points(name) : points(owner),
      why: both ? 'its name and owner match the image' : name ? 'its name matches the image' : 'its owner matches the image',
    })
  }
  ranked.sort((a, b) => b.score - a.score)
  return { ranked, packaging }
}

// ------------------------------------------------------------------ LinuxServer build files

/**
 * The upstream a LinuxServer build file reads its releases from: `EXT_USER`/`EXT_REPO` when
 * it declares them (tautulli, heimdall), else the first GitHub API URL its version command
 * calls (code-server). Null when it reads a package index or a vendor site instead -- plex,
 * mariadb and wireguard do, and there is no GitHub repository to name.
 */
export function buildFileUpstream(text: string): string | null {
  const user = /EXT_USER\s*=\s*['"]([^'"$]+)['"]/.exec(text)?.[1]
  const repo = /EXT_REPO\s*=\s*['"]([^'"$]+)['"]/.exec(text)?.[1]
  if (user && repo) {
    const p = parseSourceLabel(`${user}/${repo}`)
    if (p.ok && !isPackagingRepo(p.repo)) return p.repo
  }
  for (const m of text.matchAll(/api\.github\.com\/repos\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/g)) {
    const p = parseSourceLabel(`${m[1]}/${m[2]}`)
    if (p.ok && !isPackagingRepo(p.repo)) return p.repo
  }
  return null
}

// ------------------------------------------------------------------ inherited labels

/** Repositories whose images other images are built FROM. */
const BASE_OWNERS = /^(docker-library|debuerreotype|tianon|alpinelinux|canonical|GoogleContainerTools|chainguard-images|wolfi-dev|nodejs|phusion|just-containers|NVIDIA)\//i
const BASE_NAMES = /baseimage|base-image|distroless|^docker-(alpine|debian|ubuntu|node|python)$/i
const BASE_TITLES = new Set([
  'almalinux', 'alpine', 'amazonlinux', 'bookworm', 'bullseye', 'busybox', 'centos', 'cuda',
  'debian', 'distroless', 'eclipse-temurin', 'fedora', 'focal', 'go', 'golang', 'jammy', 'nginx',
  'node', 'noble', 'openjdk', 'php', 'python', 'rockylinux', 'ruby', 'rust', 'ubuntu', 'wolfi',
])

/**
 * Why a source label in an image's config probably came from its base image, or null.
 *
 * Config labels are inherited: an image built `FROM ubuntu` carries Ubuntu's labels unless it
 * overrides them, and minuspod's image carries nothing else. Manifest annotations are not
 * inherited, which is why only labels go through this.
 */
export function looksInherited(
  labels: Record<string, string>,
  repository: string,
  tag: string | null,
  repo: string,
): string | null {
  const [owner = '', name = ''] = repo.split('/')
  if (BASE_OWNERS.test(`${owner}/`) || BASE_NAMES.test(name)) {
    return `${repo} publishes base images`
  }
  const title = labels['org.opencontainers.image.title'] ?? labels['org.opencontainers.image.ref.name']
  if (title && BASE_TITLES.has(title.trim().toLowerCase()) && !nameRelation(repository, `x/${title}`)) {
    return `the image's labels describe ${title.trim()}`
  }
  const version = labels['org.opencontainers.image.version'] ?? labels['org.label-schema.version']
  if (version && tag) {
    const a = versionKey(version)
    const b = versionKey(tag)
    if (a && b && !versionsAgree(a, b)) {
      return `the labels give version ${version.trim()}, and the tag is ${tag}`
    }
  }
  return null
}

/**
 * Whether a version label and a tag could name the same release. A two-component value
 * (`22.04`, a `v3.7` pin) names a line, so it agrees with anything on that line.
 */
function versionsAgree(a: VersionKey, b: VersionKey): boolean {
  if (a.family !== b.family) return false
  if (!a.partial && !b.partial) return sameVersion(a, b)
  const n = Math.min(a.core.length, b.core.length)
  return a.core.slice(0, n).every((part, i) => part === b.core[i])
}
