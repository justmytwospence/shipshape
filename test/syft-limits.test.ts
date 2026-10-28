import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PolicySchema } from '../src/config.ts'
import { rateBytes, syftLimitArgs, timeoutFor, writeCapBytes, type Exec } from '../src/security/sbom.ts'

const sized = (bytes: number): Exec => async () => ({ exitCode: 0, stdout: String(bytes), stderr: '' })

test('syft limits: defaults keep the old memory/cpu and add a low CPU weight, no disk caps', () => {
  const p = PolicySchema.parse({})
  assert.deepEqual(syftLimitArgs(p), ['--memory', '8g', '--cpus', '2', '--cpu-shares', '256'])
  assert.equal(p.security.syft.parallel, 3)
  assert.equal(writeCapBytes(p), 0)
})

test('syft limits: device caps become docker flags; the slowest write cap counts', () => {
  const p = PolicySchema.parse({
    security: { syft: { parallel: 1, device_write_bps: ['/dev/nvme0n1:8mb', '/dev/sda:16mb'], device_read_bps: ['/dev/nvme0n1:150mb'] } },
  })
  assert.deepEqual(syftLimitArgs(p).slice(6), [
    '--device-write-bps', '/dev/nvme0n1:8mb',
    '--device-write-bps', '/dev/sda:16mb',
    '--device-read-bps', '/dev/nvme0n1:150mb',
  ])
  assert.equal(writeCapBytes(p), 8 * 1024 ** 2)
})

test('syft limits: a malformed device rate is refused', () => {
  assert.throws(() => PolicySchema.parse({ security: { syft: { device_write_bps: ['nvme0n1:8mb'] } } }))
  assert.throws(() => PolicySchema.parse({ security: { syft: { device_write_bps: ['/dev/nvme0n1;rm -rf /:8mb'] } } }))
})

test('syft timeout: unchanged without a write cap, stretched to write the image twice under one', async () => {
  assert.equal(rateBytes('8mb'), 8 * 1024 ** 2)
  assert.equal(rateBytes('512k'), 512 * 1024)
  assert.equal(rateBytes('nonsense'), 0)
  // 3 GB, uncapped: 7.5 minutes as before
  assert.equal(await timeoutFor('sha256:x', sized(3e9)), 7.5 * 60_000)
  // 3 GB at 8 MB/s: 2 * 3e9 / 8 MiB/s = 715 s = 11.9 min, + 3 = 14.9 min
  const t = await timeoutFor('sha256:x', sized(3e9), 8 * 1024 ** 2)
  assert.ok(t > 14 * 60_000 && t < 15.5 * 60_000, String(t))
  // never past 90 minutes
  assert.equal(await timeoutFor('sha256:x', sized(100e9), 8 * 1024 ** 2), 90 * 60_000)
  // a tiny image keeps the 5 minute floor
  assert.equal(await timeoutFor('sha256:x', sized(1e6), 8 * 1024 ** 2), 5 * 60_000)
})
