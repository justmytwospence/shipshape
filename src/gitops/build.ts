import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitBranch, loadPolicy } from '../config.ts'
import { bumpFork, readForkPin, retireFork } from '../compose/fork-edit.ts'
import { clearForkConflict, forkRefs, recordForkConflict, recordForkPrepared } from '../forks.ts'
import { prepareFork as realPrepareFork, upstreamUrlFor, type PrepareForkInput, type PrepareForkResult } from '../forks/rebase.ts'
import { headDigest } from '../registry/index.ts'
import { sameVersion, versionKey } from '../versions/key.ts'
import { parseImageRef, formatImageRef } from '../images/ref.ts'
import { rewriteFroms } from '../compose/dockerfile.ts'
import { type GroupMember, type UpdateGroup } from '../groups.ts'
import { sourceFor } from '../resolver/index.ts'
import { applyForkEdit, bumpImage } from './editor.ts'
import { type BasePrInfo, type ForkPrInfo, changeTitle } from './body.ts'
import { authorArgs, git } from './repo.ts'
import { composeFileFor, isFork, baseDockerfileFor } from '../images/rows.ts'

/**
 * Write the bump onto `branch` and commit it, returning the new head.
 *
 * Used by the ship pass and by drafting a config change. It always cuts from the freshly-fetched origin tip rather than from whatever the
 * work clone happened to be on -- which for a retarget is also what discards the previous
 * target's commit, and any config draft written on top of it.
 *
 * Nothing is logged here. The two ways this fails mean different things to each caller.
 */
/**
 * What `buildBranch` reaches outside the work clone, replaceable so a test can hand it a
 * replay that already happened and a registry that answers.
 */
export interface BuildDeps {
  prepareFork: (input: PrepareForkInput) => Promise<PrepareForkResult>
  /** The digest of an upstream tag, for a fork whose pin carries one. */
  digestFor: (registry: string, repository: string, tag: string) => Promise<string | null>
  /** The upstream repository (`owner/repo`) an image comes from. */
  sourceRepoFor: (m: GroupMember) => Promise<string | null>
}


const realDeps: BuildDeps = {
  prepareFork: realPrepareFork,
  digestFor: headDigest,
  sourceRepoFor: async (m) => {
    const ref = parseImageRef(m.image)
    try {
      const r = await sourceFor(
        { registry: ref.registry, repository: ref.repository },
        { service: { stack: m.stack, service: m.service }, tag: ref.tag ?? m.from_tag },
      )
      return r.repo
    } catch {
      return null
    }
  },
}


export type BuildResult =
  | { ok: true; sha: string; forks: Map<number, ForkPrInfo>; bases: Map<number, BasePrInfo> }
  | { ok: false; alreadyApplied?: boolean; conflict?: boolean; reason: string }


export async function buildBranch(
  repoDir: string,
  group: UpdateGroup,
  branch: string,
  deps: BuildDeps = realDeps,
): Promise<BuildResult> {
  await git(repoDir, ['checkout', '-B', branch, `origin/${gitBranch()}`])
  const forks = new Map<number, ForkPrInfo>()
  const bases = new Map<number, BasePrInfo>()

  for (const m of group.members) {
    const file = composeFileFor(m.stack, m.service)
    if (!file) return { ok: false, reason: `no compose file recorded for ${m.stack}/${m.service}` }

    if (isFork(m.stack, m.service)) {
      const r = await buildForkMember(repoDir, file, m, deps)
      if (!r.ok) return r
      forks.set(m.id, r.info)
      continue
    }

    const dockerfile = baseDockerfileFor(m.stack, m.service)
    if (dockerfile) {
      const r = await buildBaseMember(repoDir, dockerfile, m, deps)
      if (!r.ok) return r
      bases.set(m.id, r.info)
      continue
    }

    const oldRef = m.image
    const newRef = rewriteRef(oldRef, m.to_tag)
    if (!newRef) return { ok: false, reason: `cannot build a new reference from "${m.to_tag}"` }

    const edit = await bumpImage({
      repoDir,
      composeFile: file,
      service: m.service,
      expectedOldRef: oldRef,
      newRef,
    })
    if (!edit.ok) return { ok: false, alreadyApplied: edit.alreadyApplied, reason: edit.reason }
  }

  await git(repoDir, [...authorArgs(), 'commit', '-am', changeTitle(group, forks, bases)])
  return { ok: true, sha: (await git(repoDir, ['rev-parse', 'HEAD'])).stdout, forks, bases }
}


/**
 * Our own build's bump: the final stage's `FROM` moves to the new base (compose/dockerfile.ts),
 * and nothing else in the Dockerfile or the compose file changes. A digest pin is kept: the
 * new tag's digest is looked up, and the edit refused rather than written without it.
 */
async function buildBaseMember(
  repoDir: string,
  dockerfile: string,
  m: GroupMember,
  deps: BuildDeps,
): Promise<{ ok: true; info: BasePrInfo } | Extract<BuildResult, { ok: false }>> {
  const who = `${m.stack}/${m.service}`
  const abs = join(repoDir, dockerfile)
  let text: string
  try {
    text = readFileSync(abs, 'utf8')
  } catch (err) {
    return { ok: false, reason: `cannot read ${dockerfile}: ${(err as Error).message}` }
  }
  const next = await upstreamRefAt(m.image, m.to_tag, deps.digestFor)
  if (!next.ok) return { ok: false, reason: `${who}: ${next.reason}` }
  // `m.image` is the base exactly as the final stage named it when this update was found:
  // the same assertion bumpImage makes on an image line. Past it means done; anything
  // else means a person edited the Dockerfile and should look.
  const edit = rewriteFroms(text, m.image, next.ref)
  if (!edit.ok) return { ok: false, alreadyApplied: edit.alreadyApplied, reason: `${dockerfile}: ${edit.reason}` }
  writeFileSync(abs, edit.text)
  const diff = await git(repoDir, ['diff', '--quiet', '--', dockerfile], { allowFail: true })
  if (diff.exitCode === 0) return { ok: false, reason: `${dockerfile}: the edit produced no diff` }
  return { ok: true, info: { dockerfile, fromRef: m.image, toRef: next.ref, lines: edit.count } }
}


/**
 * A fork's bump is a replay of our fixes onto the new release (src/forks/rebase.ts),
 * then the compose edit that moves its pins onto the result (compose/fork-edit.ts) --
 * or, when nothing is left to carry, the edit that puts the plain upstream image back.
 *
 * A conflict is written down and raised as an incident here, because this is where it is
 * found; the pass leaves the update alone afterwards until the pin or the target changes
 * (see `eligibleGroups`). A successful replay clears whatever conflict was recorded.
 */
async function buildForkMember(
  repoDir: string,
  file: string,
  m: GroupMember,
  deps: BuildDeps,
): Promise<{ ok: true; info: ForkPrInfo } | Extract<BuildResult, { ok: false }>> {
  const who = `${m.stack}/${m.service}`
  let text: string
  try {
    text = readFileSync(join(repoDir, file), 'utf8')
  } catch (err) {
    return { ok: false, reason: `cannot read ${file}: ${(err as Error).message}` }
  }
  const targetTag = m.to_tag.split('@')[0]!
  const fromTag = m.from_tag.split('@')[0]!
  const upstreamRef = await upstreamRefAt(m.image, m.to_tag, deps.digestFor)
  if (!upstreamRef.ok) return { ok: false, reason: `${who}: ${upstreamRef.reason}` }

  const read = readForkPin(text, m.service)
  if (!read.ok) {
    // No fork pin to read: retired already -- by an earlier pass, or by hand -- is done,
    // and anything else is a shape to look at.
    const retired = retireFork(text, m.service, { expectedSha: '', upstreamRef: upstreamRef.ref })
    if (!retired.ok && retired.alreadyApplied) return { ok: false, alreadyApplied: true, reason: `${who}: ${retired.reason}` }
    return { ok: false, reason: `${who}: ${read.reason}` }
  }
  const pin = read.pin
  // The same assertion bumpImage makes on an image line: the file must still be where
  // this update was computed from. Past it means done; anywhere else means a person.
  if (sameTag(pin.baseTag, targetTag)) {
    return { ok: false, alreadyApplied: true, reason: `${file} already builds ${m.service} from ${targetTag} (${pin.sha.slice(0, 7)})` }
  }
  if (!sameTag(pin.baseTag, fromTag)) {
    return { ok: false, reason: `${file} now builds ${m.service} from ${pin.baseTag}, expected ${fromTag}` }
  }

  const refs = forkRefs(m.stack, m.service)
  const waitsOn = refs.map((r) => ({ ref: r.ref, state: r.state, releasedIn: r.releasedIn }))
  const upstreamUrl = upstreamUrlFor(await deps.sourceRepoFor(m), refs.map((r) => r.ref))
  if (!upstreamUrl) {
    return {
      ok: false,
      reason: `${who}: no upstream repository is known to rebase onto -- add a shipshape.source label naming it`,
    }
  }
  const { forks } = loadPolicy().policy
  const prepared = await deps.prepareFork({
    forkUrl: pin.contextUrl,
    upstreamUrl,
    pinnedSha: pin.sha,
    baseTag: pin.baseTag,
    targetTag,
    waitsOn,
    shortLength: pin.shortSha.length,
    branch: forks.branch,
    tagPrefix: forks.tag_prefix,
  })

  switch (prepared.kind) {
    case 'refused':
      return { ok: false, reason: `${who}: ${prepared.reason}` }
    case 'conflict':
      await recordForkConflict(m.stack, m.service, {
        toTag: targetTag,
        sha: pin.sha,
        commit: prepared.commit.sha,
        subject: prepared.commit.subject,
        files: prepared.files,
        detail: prepared.detail,
      })
      return { ok: false, conflict: true, reason: `${who}: ${prepared.detail}` }
    case 'retire':
    case 'bump':
      break
  }

  const edit =
    prepared.kind === 'retire'
      ? retireFork(text, m.service, { expectedSha: pin.sha, upstreamRef: upstreamRef.ref })
      : bumpFork(text, m.service, {
          expectedSha: pin.sha,
          newSha: prepared.sha,
          newTag: targetTag,
          newUpstream: upstreamRef.ref,
        })
  if (!edit.ok) return { ok: false, alreadyApplied: edit.alreadyApplied, reason: `${who}: ${edit.reason}` }
  const landed = await applyForkEdit({ repoDir, composeFile: file, text: edit.text })
  if (!landed.ok) return { ok: false, reason: `${who}: ${landed.reason}` }

  const info: ForkPrInfo = {
    kind: prepared.kind,
    fromSha: pin.sha,
    sha: prepared.kind === 'bump' ? prepared.sha : null,
    tag: prepared.kind === 'bump' ? prepared.tag : null,
    forkUrl: pin.contextUrl,
    upstreamRef: upstreamRef.ref,
    carried: prepared.kind === 'bump' ? prepared.carried : [],
    dropped: prepared.dropped,
    waitsOn,
  }
  recordForkPrepared(m.stack, m.service, { ...info, waitsOn, forkUrl: pin.contextUrl, toTag: targetTag })
  await clearForkConflict(m.stack, m.service)
  return { ok: true, info }
}


/** The same version in either spelling (`v3.5.1` / `3.5.1`), or the same string. */
function sameTag(a: string, b: string): boolean {
  if (a === b) return true
  const ka = versionKey(a)
  const kb = versionKey(b)
  return !!ka && !!kb && sameVersion(ka, kb)
}


/**
 * The upstream reference at the new version: the tag, keeping a digest pin when the
 * current reference has one. A `to_tag` that carries its own digest is used as is; one that
 * does not, on a digest-pinned upstream, has its digest looked up -- and the edit is refused
 * rather than written without the pin when the registry does not answer.
 */
export async function upstreamRefAt(
  currentRef: string,
  toTag: string,
  digestFor: BuildDeps['digestFor'],
): Promise<{ ok: true; ref: string } | { ok: false; reason: string }> {
  const ref = parseImageRef(currentRef)
  const at = toTag.indexOf('@')
  if (at !== -1 || !ref.digest) {
    const out = rewriteRef(currentRef, toTag)
    return out ? { ok: true, ref: out } : { ok: false, reason: `cannot build a new reference from "${toTag}"` }
  }
  let digest: string | null = null
  try {
    digest = await digestFor(ref.registry, ref.repository, toTag)
  } catch (err) {
    return { ok: false, reason: `could not resolve the digest of ${ref.repository}:${toTag} (${(err as Error).message}); the digest pin would be lost` }
  }
  if (!digest) {
    return { ok: false, reason: `could not resolve the digest of ${ref.repository}:${toTag}; the digest pin would be lost` }
  }
  return { ok: true, ref: formatImageRef(ref, toTag, digest) }
}


export function rewriteRef(currentRef: string, toTag: string): string | null {
  const ref = parseImageRef(currentRef)
  const at = toTag.indexOf('@')
  if (at === -1) return formatImageRef(ref, toTag, null)
  const tag = toTag.slice(0, at) || ref.tag
  return formatImageRef(ref, tag, toTag.slice(at + 1))
}
