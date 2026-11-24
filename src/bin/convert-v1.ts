/**
 * Rewrite the labels and policy keys of the pull-request era (v1) in the words shipshape
 * reads now, as one commit in the live checkout.
 *
 *   npm run convert-v1                # dry run: what would change
 *   npm run convert-v1 -- --write     # one commit in the live checkout
 *
 * In the container: `node dist/bin/convert-v1.js [--write]`.
 *
 * Stop shipshape before `--write`. This is a separate process, so it cannot take the
 * running app's git lock; instead it refuses a checkout that is off the configured branch
 * or has changes in any file it would touch, and refuses to commit if HEAD moved while it
 * worked.
 *
 * Exit codes: 0 nothing (left) to convert, 1 something is still unconverted (always after
 * a dry run that found work), 2 refused or failed, with nothing changed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { botIdentity, configured, env, gitBranch, paths } from '../env.ts'
import { scanRepo } from '../compose/scan.ts'
import { setLabel } from '../compose/edit.ts'
import { composeRejects } from '../gitops/labels.ts'
import { git } from '../gitops/repo.ts'
import {
  applyPolicyEdits,
  describeLabelEdit,
  describePolicyEdit,
  planPolicy,
  planServiceLabels,
  type LabelEdit,
  type PolicyEdit,
} from '../v1/convert.ts'

const write = process.argv.slice(2).includes('--write')

interface Plan {
  labels: Map<string, LabelEdit[]>
  policy: PolicyEdit[]
  policyRel: string
  /** The policy file is outside REPO_DIR: reported, never written. */
  policyOutside: boolean
}

function plan(): Plan {
  const labels = new Map<string, LabelEdit[]>()
  for (const svc of scanRepo(env.repoDir, [])) {
    const edits = planServiceLabels(svc.composeFile, svc.service, svc.labels)
    if (edits.length > 0) labels.set(svc.composeFile, [...(labels.get(svc.composeFile) ?? []), ...edits])
  }
  const rel = relative(env.repoDir, paths.policy)
  const policyOutside = rel.startsWith('..') || isAbsolute(rel)
  // The one direct env read: the webhook sink reads NOTIFY_URL itself (src/notify/sinks/webhook.ts).
  const policy = existsSync(paths.policy)
    ? planPolicy(readFileSync(paths.policy, 'utf8'), { notifyUrlSet: !!process.env.NOTIFY_URL })
    : []
  return { labels, policy, policyRel: policyOutside ? paths.policy : rel, policyOutside }
}

function print(p: Plan): void {
  for (const [file, edits] of p.labels) {
    console.log(file)
    for (const e of edits) console.log(`  ${describeLabelEdit(e)}`)
  }
  if (p.policy.length > 0) {
    console.log(p.policyRel)
    for (const e of p.policy) console.log(`  ${describePolicyEdit(e)}`)
  }
}

const isEmpty = (p: Plan) => p.labels.size === 0 && p.policy.length === 0

function refuse(message: string): never {
  console.error(message)
  process.exit(2)
}

async function main(): Promise<void> {
  const ready = configured()
  if (!ready.ok) {
    for (const m of ready.missing) console.error(`${m.name}: ${m.why}`)
    process.exit(2)
  }

  const first = plan()
  if (isEmpty(first)) {
    console.log('Nothing to convert.')
    process.exit(0)
  }
  print(first)
  if (!write) {
    console.log('\nDry run: nothing was changed. Run again with --write to apply it as one commit.')
    process.exit(1)
  }

  const unconverted: string[] = []
  if (first.policy.length > 0 && first.policyOutside) {
    unconverted.push(`${paths.policy} is outside REPO_DIR; edit it by hand`)
  }
  const targets = [...first.labels.keys()]
  if (first.policy.length > 0 && !first.policyOutside) targets.push(first.policyRel)

  // Guards: nothing has been written yet, so a refusal leaves nothing to restore.
  const repo = env.repoDir
  const head = (await git(repo, ['symbolic-ref', '--short', 'HEAD'], { allowFail: true })).stdout
  if (head !== gitBranch())
    refuse(`The checkout is on "${head || 'a detached HEAD'}", not ${gitBranch()}. Nothing was changed.`)
  for (const rel of targets) {
    const tracked = await git(repo, ['ls-files', '--error-unmatch', '--', rel], { allowFail: true })
    if (tracked.exitCode !== 0) refuse(`${rel} is not tracked by git. Commit it first.`)
    const dirty = await git(repo, ['diff', '--quiet', '--', rel], { allowFail: true })
    const staged = await git(repo, ['diff', '--cached', '--quiet', '--', rel], { allowFail: true })
    if (dirty.exitCode !== 0 || staged.exitCode !== 0)
      refuse(`${rel} has uncommitted changes. Commit or discard them first.`)
  }
  const headBefore = (await git(repo, ['rev-parse', 'HEAD'])).stdout

  // Edit in memory.
  const originals = new Map<string, string>()
  const next = new Map<string, string>()
  for (const [rel, edits] of first.labels) {
    const original = readFileSync(join(repo, rel), 'utf8')
    let text = original
    const refused = new Set<string>()
    for (const e of edits) {
      if (refused.has(e.service)) continue
      const r = setLabel(text, e.service, e.key, e.value)
      if (!r.ok) {
        unconverted.push(`${rel} ${e.service}: ${r.reason}`)
        refused.add(e.service)
        continue
      }
      text = r.text
    }
    if (text !== original) {
      originals.set(rel, original)
      next.set(rel, text)
    }
  }
  if (first.policy.length > 0 && !first.policyOutside) {
    const original = readFileSync(paths.policy, 'utf8')
    const r = applyPolicyEdits(original, first.policy)
    if (!r.ok) unconverted.push(`${first.policyRel}: ${r.reason}`)
    else if (r.text !== original) {
      originals.set(first.policyRel, original)
      next.set(first.policyRel, r.text)
    }
  }

  const files = [...next.keys()]
  const restore = async () => {
    for (const rel of files) {
      await git(repo, ['reset', '-q', 'HEAD', '--', rel], { allowFail: true })
      writeFileSync(join(repo, rel), originals.get(rel)!)
      await git(repo, ['checkout', '--', rel], { allowFail: true })
    }
  }
  const fail = async (reason: string): Promise<never> => {
    await restore()
    refuse(`${reason}. Every file was restored; nothing was committed.`)
  }

  if (files.length > 0) {
    for (const rel of files) writeFileSync(join(repo, rel), next.get(rel)!)

    // Gates, on compose files only: the policy file was validated by applyPolicyEdits.
    for (const rel of files) {
      if (rel === first.policyRel) continue
      const rejected = await composeRejects(join(repo, rel))
      if (rejected !== null) await fail(`Compose rejected the edited ${rel}: ${rejected}`)
      const diff = await git(repo, ['diff', '-U0', '--', rel], { allowFail: true })
      const offending = diff.stdout
        .split('\n')
        .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
        .filter((l) => !/^[+-]\s*(shipshape\.(policy|pr|claude|class|review):|labels:\s*$)/.test(l))
      if (offending.length > 0)
        await fail(`The edit of ${rel} touched a non-label line: ${offending[0]!.slice(0, 120)}`)
    }

    const headNow = (await git(repo, ['rev-parse', 'HEAD'], { allowFail: true })).stdout
    if (headNow !== headBefore) await fail('The checkout moved while converting (is shipshape still running?)')

    try {
      await git(repo, ['add', '--', ...files])
      await git(repo, [
        ...botIdentity(),
        'commit',
        '-q',
        '-m',
        'chore(shipshape): convert v1 labels and policy keys',
        '--',
        ...files,
      ])
    } catch (err) {
      await fail(`Could not commit: ${(err as Error).message}`)
    }
    const short = (await git(repo, ['rev-parse', '--short', 'HEAD'])).stdout
    console.log(`\nCommitted ${short}. shipshape publishes it with its next sync.`)
  }

  // What is left, read again from disk.
  const after = plan()
  if (isEmpty(after) && unconverted.length === 0) process.exit(0)
  console.log('\nStill unconverted:')
  print(after)
  for (const u of unconverted) console.log(`  ${u}`)
  process.exit(1)
}

await main()
