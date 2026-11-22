import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { parseRemote } from '../src/config.ts'
import { credentialArgs } from '../src/gitops/credentials.ts'

/** A token goes to the host it belongs to, and to no other. */

const SECRET = { SHIPSHAPE_GIT_USERNAME: 'me', SHIPSHAPE_GIT_PASSWORD: 'tok-123' }

function fill(args: string[], host: string): string {
  try {
    return execFileSync('git', [...args, 'credential', 'fill'], {
      input: `protocol=https\nhost=${host}\n\n`,
      env: { ...process.env, ...SECRET, GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

test("the token is offered to the remote's host and nowhere else", () => {
  const args = credentialArgs('compose', parseRemote('https://git.example.test/me/c.git', ''))
  assert.match(fill(args, 'git.example.test'), /password=tok-123/)
  assert.doesNotMatch(fill(args, 'evil.example.test'), /password=/)
  assert.doesNotMatch(fill(args, 'github.com'), /password=/)
})

test('the GitHub credential is for github.com only; a local remote gets none', () => {
  const gh = credentialArgs('github', parseRemote('/tmp/origin.git', ''))
  assert.match(fill(gh, 'github.com'), /password=tok-123/)
  assert.doesNotMatch(fill(gh, 'git.example.test'), /password=/)
  assert.deepEqual(credentialArgs('compose', parseRemote('/tmp/origin.git', '')), ['-c', 'credential.helper='])
})
