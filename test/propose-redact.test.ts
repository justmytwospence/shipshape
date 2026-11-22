import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets } from '../src/propose/redact.ts'

test('secret-looking values are replaced, references and names are kept', () => {
  const out = redactSecrets(
    [
      'environment:',
      '  DB_PASSWORD: hunter2',
      '  - API_KEY=abc',
      '  TOKEN: ${TOKEN}',
      '  URL: postgres://u:pw@db/x',
      '  PORT: 80',
    ].join('\n'),
  )
  assert.match(out, /DB_PASSWORD: "<redacted>"/)
  assert.match(out, /- API_KEY="<redacted>"/)
  assert.match(out, /TOKEN: \$\{TOKEN\}/)
  assert.match(out, /postgres:\/\/u:<redacted>@db\/x/)
  assert.match(out, /PORT: 80/)
  assert.doesNotMatch(out, /hunter2|abc|pw@/)
})
