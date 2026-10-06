import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execa } from 'execa'
import { dockerEnv, dockerEnvOptions } from '../src/deploy/docker-env.ts'

/**
 * Compose interpolation prefers the caller's environment over a stack's `.env`, so
 * anything shipshape's own process carries must not reach `docker compose`.
 */

const SENTINELS = {
  OPENROUTER_API_KEY: 'sentinel-openrouter',
  NTFY_TOKEN: 'sentinel-ntfy',
  PUID: '4242',
  DOMAIN: 'sentinel.example',
  COMPOSE_PROFILES: 'disabled',
  GITHUB_TOKEN: 'sentinel-github',
}

test('application settings and compose overrides are not passed to docker', () => {
  const env = dockerEnv({ ...SENTINELS, PATH: '/usr/bin', HOME: '/home/x', DOCKER_HOST: 'unix:///s' })
  for (const k of Object.keys(SENTINELS)) assert.equal(env[k], undefined, k)
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/x', DOCKER_HOST: 'unix:///s' })
})

test("a child started with these options does not inherit this process's settings", async () => {
  const saved = { ...process.env }
  Object.assign(process.env, SENTINELS)
  try {
    const r = await execa(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      dockerEnvOptions(),
    )
    const seen = JSON.parse(r.stdout) as Record<string, string>
    for (const k of Object.keys(SENTINELS)) assert.equal(seen[k], undefined, k)
    assert.equal(seen.PATH, process.env.PATH)
  } finally {
    for (const k of Object.keys(SENTINELS)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
})
