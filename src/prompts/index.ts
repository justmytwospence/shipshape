import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb } from '../db.ts'

/**
 * The system prompts, and the operator's edits to them.
 *
 * The defaults live in `.md` files next to this one so they can be read and reviewed as
 * prose rather than dug out of a template literal. Prompts are the part of this tool
 * most worth arguing with, and an argument needs something legible to point at.
 *
 * An operator edit is stored in the database rather than written back to the file: the
 * file is the shipped default and stays diffable across upgrades, and "reset" is a
 * delete rather than a restore.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

export type PromptName = 'verdict' | 'proposal' | 'revision'

export const PROMPTS: Record<PromptName, { title: string; help: string }> = {
  verdict: {
    title: 'Changelog review',
    help: 'Runs on every update. Decides approve / caution / block, and can withhold an auto-merge but never cause one.',
  },
  proposal: {
    title: 'Config changes',
    help: 'Runs when a verdict reports breakage. Drafts the compose changes an update needs beyond its tag.',
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

/** The prompt actually used: the operator's version if they wrote one, else the default. */
export function prompt(name: PromptName): string {
  const row = getDb().prepare(`SELECT body FROM prompts WHERE name = ?`).get(name) as
    | { body: string }
    | undefined
  const body = row?.body?.trim()
  return body ? body : defaultPrompt(name)
}

export function isCustomised(name: PromptName): boolean {
  const row = getDb().prepare(`SELECT body FROM prompts WHERE name = ?`).get(name) as
    | { body: string }
    | undefined
  return !!row?.body?.trim() && row.body.trim() !== defaultPrompt(name)
}

/** Save an edit, or clear it when the text is empty or matches the default. */
export function savePrompt(name: PromptName, body: string): void {
  const trimmed = body.trim()
  const db = getDb()
  if (!trimmed || trimmed === defaultPrompt(name)) {
    db.prepare(`DELETE FROM prompts WHERE name = ?`).run(name)
    return
  }
  db.prepare(
    `INSERT INTO prompts (name, body, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
  ).run(name, trimmed, new Date().toISOString())
}

export function resetPrompt(name: PromptName): void {
  getDb().prepare(`DELETE FROM prompts WHERE name = ?`).run(name)
}
