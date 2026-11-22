import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { credentialArgs, gitCredentials } from '../src/gitops/repo.ts'

/** A token goes to the host it belongs to, and to no other. */

function fill(args: string[], env: Record<string, string>, host: string): string {
  try {
    return execFileSync('git', [...args, 'credential', 'fill'], {
      input: `protocol=https\nhost=${host}\n\n`,
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

test("the token is offered to the remote's host and nowhere else", () => {
  const { args, env } = credentialArgs(gitCredentials('https://git.example.test/me/c.git', 'tok-123'))
  assert.match(fill(args, env, 'git.example.test'), /password=tok-123/)
  assert.doesNotMatch(fill(args, env, 'evil.example.test'), /password=/)
})

test('github.com gets the GitHub token for forks; a local remote gets nothing of its own', () => {
  assert.deepEqual(gitCredentials('/tmp/origin.git', 't'), [{ origin: 'https://github.com', username: 'x-access-token', password: 't' }])
  assert.equal(gitCredentials('https://github.com/a/b.git', 't').length, 1)
  assert.deepEqual(gitCredentials('https://x/y', ''), [])
})
