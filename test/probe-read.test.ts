import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DockerUnreadable,
  inspectService,
  parseInspect,
  primary,
  readInspect,
  readPs,
  type ExecResult,
} from '../src/deploy/probe.ts'

/**
 * "No container" and "could not ask" are different answers.
 *
 * They were one value. A `docker ps` that failed -- no permission on the socket, a
 * daemon mid-restart -- came back as an empty list, the empty list read as absent, and
 * the verifier treats a persistent absence as a hard failure: a blind verifier failed
 * good deploys and reverted main. Everything here is pure or runs against a scripted
 * exec, so no daemon is anywhere near it.
 */

/** A docker that answers from a script, one reply per call, `ps` and `inspect` separately. */
function scripted(ps: ExecResult[], inspect: ExecResult[]) {
  const calls: string[][] = []
  const exec = async (args: string[]): Promise<ExecResult> => {
    calls.push(args)
    const next = args[0] === 'ps' ? ps.shift() : inspect.shift()
    if (!next) throw new Error(`unscripted docker ${args.join(' ')}`)
    return next
  }
  return { exec, calls }
}

test('a docker that cannot be reached is not a stopped service', () => {
  assert.throws(
    () =>
      readPs({
        exitCode: 1,
        stdout: '',
        stderr:
          'Cannot connect to the Docker daemon at unix:///nonexistent.sock. Is the docker daemon running?',
      }),
    (e: unknown) => e instanceof DockerUnreadable && /Cannot connect/.test(e.message),
  )
})

test('a docker that never answers is not a stopped service', () => {
  assert.throws(() => readPs({ timedOut: true }), DockerUnreadable)
})

test('no container is absent, and only when docker said so', () => {
  assert.deepEqual(readPs({ exitCode: 0, stdout: '' }), [])
  assert.deepEqual(readPs({ exitCode: 0, stdout: 'a\n\nb\n' }), ['a', 'b'])
})

test('inspect printing [] while failing is not an empty answer', () => {
  // `docker inspect` writes `[]` to stdout even when it never reached the daemon, so the
  // exit code has to be read first or this looks exactly like "nothing there".
  assert.throws(
    () =>
      readInspect('svc', {
        exitCode: 1,
        stdout: '[]',
        stderr: 'permission denied while trying to connect to the Docker daemon socket',
      }),
    DockerUnreadable,
  )
})

test('a container that vanished is gone', () => {
  assert.equal(
    readInspect('svc', { exitCode: 1, stdout: '[]', stderr: 'Error: No such object: 0123456789ab' }),
    'gone',
  )
})

test('unreadable output is not a container', () => {
  assert.throws(() => readInspect('svc', { exitCode: 0, stdout: 'nope' }), DockerUnreadable)
  assert.throws(
    () => readInspect('svc', { exitCode: 0, stdout: '[{"Id":"x"}]' }),
    (e: unknown) => e instanceof DockerUnreadable && /no state/.test(e.message),
  )
})

test('any running container makes the service running', async () => {
  assert.equal(
    primary([
      parseInspect('s', { State: { Status: 'exited' } }),
      parseInspect('s', { State: { Status: 'running' } }),
    ]).state,
    'running',
  )

  const { exec, calls } = scripted(
    [{ exitCode: 0, stdout: 'a\nb\n' }],
    [
      {
        exitCode: 0,
        stdout: JSON.stringify([
          { Id: 'a', State: { Status: 'exited' } },
          { Id: 'b', State: { Status: 'running' } },
        ]),
      },
    ],
  )
  const obs = await inspectService('p', 's', exec)
  assert.equal(obs.state, 'running')
  assert.equal(obs.id, 'b')
  assert.deepEqual(calls[1], ['inspect', 'a', 'b'], 'every listed container is read, not the first')
})

test('vanished between ps and inspect reads absent', async () => {
  const { exec } = scripted(
    [
      { exitCode: 0, stdout: 'a' },
      { exitCode: 0, stdout: '' },
    ],
    [{ exitCode: 1, stdout: '[]', stderr: 'Error: No such object: a' }],
  )
  const obs = await inspectService('p', 's', exec)
  assert.equal(obs.found, false)
  assert.equal(obs.state, 'absent')
})
