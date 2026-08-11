import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execa } from 'execa'
import { parseDocument, isScalar } from 'yaml'
import { git } from './repo.ts'

/**
 * Rewriting one `image:` value and provably nothing else.
 *
 * These compose files are heavily commented -- traefik's carries 74 comment lines -- so
 * nothing here goes near a YAML emitter. The scalar is located through the document
 * tree, its byte range spliced, and the result checked three ways before it is allowed
 * to stand.
 */

export type EditResult =
  | { ok: true; file: string }
  /** `alreadyApplied` means the file already carries this bump: done, not broken. */
  | { ok: false; reason: string; alreadyApplied?: boolean }

export async function bumpImage(opts: {
  /** Repository root the edit happens in (the work clone). */
  repoDir: string
  /** Path relative to that root. */
  composeFile: string
  service: string
  expectedOldRef: string
  newRef: string
}): Promise<EditResult> {
  const { repoDir, composeFile, service, expectedOldRef, newRef } = opts
  const abs = join(repoDir, composeFile)

  let before: string
  try {
    before = readFileSync(abs, 'utf8')
  } catch (err) {
    return { ok: false, reason: `cannot read ${composeFile}: ${(err as Error).message}` }
  }

  const doc = parseDocument(before, { keepSourceTokens: true })
  const node = doc.getIn(['services', service, 'image'], true)
  if (!node || !isScalar(node) || typeof node.value !== 'string') {
    return { ok: false, reason: `no image: found for service "${service}" in ${composeFile}` }
  }
  // Several services here share byte-identical image lines (three postgres:13.2
  // sidecars), so the document node is what disambiguates -- never a text search.
  if (node.value !== expectedOldRef) {
    return {
      ok: false,
      // Distinguished because the two cases deserve opposite responses: the file having
      // moved *past* this update means the work is done, while any other mismatch means
      // something unexpected edited it and a human should look.
      alreadyApplied: node.value === newRef,
      reason:
        node.value === newRef
          ? `${composeFile} already pins "${newRef}" for ${service}`
          : `${composeFile} now pins "${node.value}" for ${service}, expected "${expectedOldRef}"`,
    }
  }
  const range = node.range
  if (!range) return { ok: false, reason: 'image value has no source range' }

  // Splice the raw bytes of the scalar. Everything outside [start, valueEnd) is
  // untouched by construction, comments included.
  const after = before.slice(0, range[0]) + newRef + before.slice(range[1])
  writeFileSync(abs, after)

  const gate = await verify({ repoDir, composeFile, abs, service, before, newRef })
  if (!gate.ok) {
    writeFileSync(abs, before)
    return gate
  }
  return { ok: true, file: composeFile }
}

async function verify(opts: {
  repoDir: string
  composeFile: string
  abs: string
  service: string
  before: string
  newRef: string
}): Promise<EditResult> {
  const { repoDir, composeFile, abs, service, before, newRef } = opts

  // Gate A: the parsed document must differ in exactly one place.
  const reparsed = parseDocument(readFileSync(abs, 'utf8'))
  if (reparsed.errors.length > 0) {
    return { ok: false, reason: `edit produced invalid YAML: ${reparsed.errors[0]!.message}` }
  }
  const original = parseDocument(before).toJS() as Record<string, unknown>
  const updated = reparsed.toJS() as Record<string, unknown>
  const services = (updated.services ?? {}) as Record<string, { image?: string }>
  if (services[service]?.image !== newRef) {
    return { ok: false, reason: 'the new reference is not what landed in the file' }
  }
  // Compare with the one intended difference normalised away.
  const origServices = (original.services ?? {}) as Record<string, { image?: string }>
  const origImage = origServices[service]?.image
  if (origServices[service]) origServices[service]!.image = newRef
  if (JSON.stringify(original) !== JSON.stringify(updated)) {
    if (origServices[service]) origServices[service]!.image = origImage
    return { ok: false, reason: 'the edit changed more than the target image value' }
  }

  // Gate B: the textual diff must be image lines only -- the same check the repo's own
  // commit script uses before it will stage anything.
  const diff = await git(repoDir, ['diff', '-U0', '--', composeFile], { allowFail: true })
  const changed = diff.stdout
    .split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
  if (changed.length === 0) return { ok: false, reason: 'the edit produced no diff' }
  const offending = changed.filter((l) => !/^[+-]\s*image:\s/.test(l))
  if (offending.length > 0) {
    return { ok: false, reason: `diff touched a non-image line: ${offending[0]!.slice(0, 120)}` }
  }

  // Gate C: compose must still accept the file. `--no-interpolate` because the work
  // clone has no .env -- this validates structure, not variable resolution.
  const cfg = await execa(
    'docker',
    ['compose', '-f', join(repoDir, composeFile), 'config', '--no-interpolate', '-q'],
    { reject: false, timeout: 60_000, cwd: repoDir },
  )
  if ((cfg.exitCode ?? 1) !== 0) {
    return {
      ok: false,
      reason: `compose rejected the edited file: ${String(cfg.stderr ?? '').slice(0, 200)}`,
    }
  }

  return { ok: true, file: composeFile }
}

/** Path of a compose file relative to a repo root, for the DB's stored value. */
export function relPath(repoDir: string, abs: string): string {
  return relative(repoDir, abs)
}
