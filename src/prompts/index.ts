import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { paths } from '../config.ts'

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

export type PromptName = 'verdict' | 'proposal' | 'revision'

export const PROMPTS: Record<PromptName, { title: string; help: string }> = {
  verdict: {
    title: 'Changelog review',
    help: 'Runs where a person will read the result. Decides approve / caution / block, and can withhold an auto-merge but never cause one.',
  },
  proposal: {
    title: 'Config changes',
    help: 'Runs when a review names steps this deployment must take. Drafts the compose changes an update needs beyond its tag.',
  },
  revision: {
    title: 'Your comments',
    help: 'Runs when you comment on an open pull request. It can answer, hold, re-read the changelog, skip, or write the change — never merge, never deploy.',
  },
}

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
  return join(dirname(paths.policy), 'prompts', `${name}.md`)
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
