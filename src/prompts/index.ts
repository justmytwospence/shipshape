import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { paths } from '../env.ts'

/**
 * The system prompts, and the operator's overrides of them.
 *
 * The defaults live in `.md` files next to this one so they can be read and reviewed as
 * prose rather than dug out of a template literal. Prompts are the part of this tool
 * most worth arguing with, and an argument needs something legible to point at.
 *
 * An override is a file beside policy.yaml -- `prompts/<name>.md` -- in the repository
 * being watched. It used to be a row in shipshape's database, edited from a textarea on
 * the Settings page: the one piece of configuration that lived outside git, could not be
 * reviewed, and vanished with the volume. Deleting the file is the reset.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

export type PromptName = 'verdict' | 'proposal' | 'rule' | 'security'

const cache = new Map<PromptName, string>()

/** The shipped default, read from disk once. */
export function defaultPrompt(name: PromptName): string {
  let text = cache.get(name)
  if (text === undefined) {
    text = readFileSync(join(HERE, `${name}.md`), 'utf8').trim()
    cache.set(name, text)
  }
  return text
}

/** Where an override for this prompt lives: beside policy.yaml, in the watched repository. */
export function overridePath(name: PromptName): string {
  // Beside the older policy.yaml layout, a prompts/ directory; beside a root shipshape.yaml,
  // shipshape-prompts/, so the repository root does not gain a generic `prompts`.
  const base = basename(paths.policy)
  const dir = base === 'policy.yaml' ? 'prompts' : `${base.replace(/\.ya?ml$/, '')}-prompts`
  return join(dirname(paths.policy), dir, `${name}.md`)
}

function override(name: PromptName): string | null {
  try {
    const text = readFileSync(overridePath(name), 'utf8').trim()
    return text ? text : null
  } catch {
    return null
  }
}

/** The prompt actually used: the tracked override if there is one, else the default. */
export function prompt(name: PromptName): string {
  return override(name) ?? defaultPrompt(name)
}

export function isCustomised(name: PromptName): boolean {
  const o = override(name)
  return o !== null && o !== defaultPrompt(name)
}
