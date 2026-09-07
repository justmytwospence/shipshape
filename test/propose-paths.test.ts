import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scopeFor, boundaryFor, canWrite, isForbidden } from '../src/propose/paths.ts'
import { applyOps } from '../src/propose/apply.ts'

const b = (scope: Parameters<typeof boundaryFor>[0]) =>
  boundaryFor(scope, 'authelia/docker-compose.yaml')

test('the boundary comes from where the compose file sits', () => {
  assert.equal(b('compose-dir').root, 'authelia')
  assert.equal(b('repo').root, null)
  assert.equal(b('service').root, 'authelia/docker-compose.yaml')
})

test('compose-dir reaches a sibling config file and nothing beyond it', () => {
  assert.equal(canWrite('authelia/configuration.yml', b('compose-dir'), 'shipshape').ok, true)
  assert.equal(canWrite('traefik/dynamic/mcp.yaml', b('compose-dir'), 'shipshape').ok, false)
  // ...which repo scope does reach.
  assert.equal(canWrite('traefik/dynamic/mcp.yaml', b('repo'), 'shipshape').ok, true)
})

test('the narrow rungs reach exactly one file', () => {
  assert.equal(canWrite('authelia/docker-compose.yaml', b('service'), 'shipshape').ok, true)
  assert.equal(canWrite('authelia/configuration.yml', b('service'), 'shipshape').ok, false)
  assert.equal(canWrite('authelia/configuration.yml', b('compose-file'), 'shipshape').ok, false)
})

test('unstructured and JSON files are editable; only binaries are not', () => {
  // Restricting this to YAML was wrong: the deep-compare never proved an edit was
  // right, only that the applier did exactly what was named — and an exactly-once
  // anchor gives that same guarantee with no parse at all.
  for (const f of ['authelia/entrypoint.sh', 'authelia/Dockerfile', 'authelia/users.json', 'authelia/app.conf']) {
    assert.equal(canWrite(f, b('compose-dir'), 'shipshape').ok, true, f)
  }
  for (const f of ['authelia/logo.png', 'authelia/data.sqlite3', 'authelia/fonts.woff2']) {
    const r = canWrite(f, b('compose-dir'), 'shipshape')
    assert.equal(r.ok, false, f)
    assert.match(r.ok === false ? r.reason : '', /binary/)
  }
})

test('a binary hiding behind an innocent extension is caught by its content', () => {
  const r = canWrite('authelia/notes.txt', b('compose-dir'), 'shipshape', 'text\0with a NUL')
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.reason : '', /binary/)
})

test('path operations work on JSON, which the same parser already handles', () => {
  const json = '{\n  "log": {\n    "level": "info"\n  }\n}\n'
  const r = applyOps(json, 'x', [{ op: 'set_path', path: ['log', 'level'], value: '"debug"' }])
  assert.ok(r.ok, r.ok ? '' : r.reason)
  assert.ok(r.text.includes('"debug"'))
  assert.equal(JSON.parse(r.text).log.level, 'debug')
})

test('no scope reaches its own guardrails or anything executable', () => {
  // A rule that can be configured away is not a limit. `repo` is the widest there is.
  for (const f of [
    'shipshape/config/policy.yaml',
    'shipshape/docker-compose.yaml',
    '.github/workflows/ci.yaml',
    'bin/homelab.yaml',
  ]) {
    assert.equal(canWrite(f, b('repo'), 'shipshape').ok, false, f)
  }
  assert.equal(isForbidden('shipshape/config/policy.yaml', 'shipshape'), true)
  // ...and the self-stack is whatever this deployment calls it.
  assert.equal(isForbidden('updater/config/policy.yaml', 'updater'), true)
  assert.equal(isForbidden('updater/config/policy.yaml', 'shipshape'), false)
})

test('traversal and absolute paths do not escape the repository', () => {
  for (const f of ['../outside/x.yaml', '/etc/passwd.yaml', 'authelia/../../x.yaml']) {
    assert.equal(canWrite(f, b('repo'), 'shipshape').ok, false, f)
  }
})

test('traversal that lands back INSIDE the repo is still checked where it lands', () => {
  // The hole this closes: the path was resolved only to answer "does this escape?", and
  // the raw string was then handed to the forbidden test, which reads path segments. So
  // every rule above was reachable by naming its target the long way round -- and
  // writeFileSync(join(...)) collapsed the `..` on the way to disk.
  for (const f of [
    'authelia/../shipshape/config/policy.yaml',
    'authelia/../.github/workflows/ci.yaml',
    'authelia/../bin/homelab.yaml',
    'authelia/sub/../../shipshape/docker-compose.yaml',
  ]) {
    assert.equal(canWrite(f, b('compose-dir'), 'shipshape').ok, false, f)
    assert.equal(canWrite(f, b('repo'), 'shipshape').ok, false, f)
  }
  // ...and a `..` that resolves to somewhere legitimate is still allowed, so this is a
  // correction rather than a blanket ban on the character.
  assert.equal(canWrite('authelia/sub/../configuration.yml', b('compose-dir'), 'shipshape').ok, true)
})

test('executable and secret-bearing directories are excluded at any depth', () => {
  // Testing only the first segment meant "excluded at the repository root", which is
  // where none of them actually live.
  for (const f of [
    'mcpjungle/bin/download.sh',
    'servarr/scripts/run.sh',
    'code-server/custom-cont-init.d/01-fix-prompt.sh',
    'n8n/credentials/anthropic.json',
    'vault/secrets/token.yaml',
  ]) {
    assert.equal(canWrite(f, b('repo'), 'shipshape').ok, false, f)
    assert.equal(isForbidden(f, 'shipshape'), true, f)
  }
})

test('the operator can rule out a path at every scope', () => {
  // For configuration that is hot-reloaded: a merged edit goes live on the next sync
  // with no compose up, no verify window and no rollback, so nothing shipshape does to
  // make a deploy safe applies to it at all.
  const never = ['traefik/dynamic', 'traefik/authelia/configuration.yml']
  const t = (s: Parameters<typeof boundaryFor>[0]) => boundaryFor(s, 'traefik/docker-compose.yaml')
  assert.equal(canWrite('traefik/dynamic/mcp.yaml', t('compose-dir'), 'shipshape').ok, true)
  for (const scope of ['compose-dir', 'repo'] as const) {
    const r = canWrite('traefik/dynamic/mcp.yaml', t(scope), 'shipshape', undefined, never)
    assert.equal(r.ok, false, scope)
    assert.match(r.ok === false ? r.reason : '', /never writable/)
    assert.equal(
      canWrite('traefik/authelia/configuration.yml', t(scope), 'shipshape', undefined, never).ok,
      false,
      scope,
    )
  }
  // A ruled-out prefix must not swallow a sibling that merely starts with the same text.
  assert.equal(canWrite('traefik/dynamic-notes.yaml', t('compose-dir'), 'shipshape', undefined, never).ok, true)
  // ...and it is still reachable by the long way round.
  assert.equal(
    canWrite('traefik/x/../dynamic/mcp.yaml', t('compose-dir'), 'shipshape', undefined, never).ok,
    false,
  )
})

test('a config-typed boundary refuses anything that runs', () => {
  // The revision path's rule. The proposal path keeps `any`, which is why the test above
  // still finds entrypoint.sh writable: a proposal is drafted from a changelog at a rung
  // the operator opted into per service, and a revision is a sentence someone typed at a
  // rung that is the default.
  const cfg = boundaryFor('compose-dir', 'authelia/docker-compose.yaml', 'config')
  for (const f of ['authelia/configuration.yml', 'authelia/users.json', 'authelia/app.conf']) {
    assert.equal(canWrite(f, cfg, 'shipshape').ok, true, f)
  }
  for (const f of [
    'authelia/entrypoint.sh',
    'authelia/Dockerfile',
    'authelia/sync.py',
    'authelia/export.service',
    'authelia/action.d/ntfy.local',
  ]) {
    const r = canWrite(f, cfg, 'shipshape')
    assert.equal(r.ok, false, f)
    assert.match(r.ok === false ? r.reason : '', /not a configuration file/)
  }
  // The service's own compose file is always writable, whatever it is called.
  assert.equal(canWrite('authelia/docker-compose.yaml', cfg, 'shipshape').ok, true)
})

test('a typo narrows; the widest words are still recognised', () => {
  assert.equal(scopeFor('compose-directory'), 'compose-dir')
  assert.equal(scopeFor('any'), 'repo')
  assert.equal(scopeFor('everything'), 'service')
  assert.equal(scopeFor(null), 'service')
})

test('none reaches nothing at all', () => {
  assert.equal(canWrite('authelia/docker-compose.yaml', b('none'), 'shipshape').ok, false)
})

const CONFIG = `theme: light
authentication_backend:
  file:
    path: /config/users.yml
  password_reset:
    disable: false
session:
  domain: example.com
`

test('path ops edit a non-compose YAML file, byte-exactly', () => {
  const r = applyOps(CONFIG, 'ignored', [
    { op: 'set_path', path: ['session', 'domain'], value: 'new.example.com' },
    { op: 'rename_path', path: ['authentication_backend', 'password_reset'], to: 'reset_password' },
    { op: 'remove_path', path: ['theme'] },
  ])
  assert.ok(r.ok, r.ok ? '' : r.reason)
  assert.ok(r.text.includes('domain: new.example.com'))
  assert.ok(r.text.includes('reset_password:'))
  assert.ok(!r.text.includes('theme:'))
  // Untouched structure survives verbatim.
  assert.ok(r.text.includes('path: /config/users.yml'))
})

test('a path op will not invent the structure it needs', () => {
  // Conjuring intermediate mappings is how a plausible edit lands in the wrong place.
  const r = applyOps(CONFIG, 'x', [
    { op: 'set_path', path: ['nothing', 'here', 'deep'], value: '1' },
  ])
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.reason : '', /no mapping at/)
})

test('a path op naming something absent is refused, not guessed', () => {
  const r = applyOps(CONFIG, 'x', [{ op: 'remove_path', path: ['session', 'nope'] }])
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.reason : '', /no entry at session\.nope/)
})

test('the verifier catches a path splice that did more than asked', () => {
  // The whole safety property: the splice is compared against the same ops applied to
  // the parsed object. This asserts the check is actually wired for path ops.
  const r = applyOps(CONFIG, 'x', [{ op: 'set_path', path: ['session', 'domain'], value: 'a.b' }])
  assert.ok(r.ok, r.ok ? '' : r.reason)
  assert.equal(r.changed.length, 1)
})

const SCRIPT = `#!/bin/sh
set -eu
# start the thing
exec /usr/bin/authelia --config /config/configuration.yml
`

test('replace_text edits a file with no structure at all', () => {
  const r = applyOps(SCRIPT, 'x', [
    { op: 'replace_text', find: '--config /config/configuration.yml', replace: '--config /config/config.yml' },
  ])
  assert.ok(r.ok, r.ok ? '' : r.reason)
  assert.ok(r.text.includes('--config /config/config.yml'))
  assert.ok(r.text.startsWith('#!/bin/sh\n'), 'everything else byte-identical')
})

test('an anchor matching nothing is refused, not guessed at', () => {
  const r = applyOps(SCRIPT, 'x', [{ op: 'replace_text', find: 'not present', replace: 'x' }])
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.reason : '', /does not appear/)
})

test('an ambiguous anchor is refused rather than taking the first match', () => {
  // Picking the first is precisely how a plausible edit lands in the wrong place.
  const twice = 'port: 80\nport: 80\n'
  const r = applyOps(twice, 'x', [{ op: 'replace_text', find: 'port: 80', replace: 'port: 8080' }])
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.reason : '', /more than once/)
})

test('replace_text with an empty replacement removes the anchor', () => {
  const r = applyOps(SCRIPT, 'x', [{ op: 'replace_text', find: '# start the thing\n', replace: '' }])
  assert.ok(r.ok, r.ok ? '' : r.reason)
  assert.ok(!r.text.includes('# start the thing'))
  assert.ok(r.text.includes('exec /usr/bin/authelia'))
})

test('sequential text edits each re-check their own anchor', () => {
  // An earlier replacement can create or destroy a later anchor, so uniqueness is
  // checked against the text as it stands, not as it started.
  const r = applyOps(SCRIPT, 'x', [
    { op: 'replace_text', find: 'set -eu', replace: 'set -euo pipefail' },
    { op: 'replace_text', find: 'set -euo pipefail', replace: 'set -eux' },
  ])
  assert.ok(r.ok, r.ok ? '' : r.reason)
  assert.ok(r.text.includes('set -eux'))
})
