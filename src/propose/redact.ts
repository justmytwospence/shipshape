/**
 * The service block as the drafting model sees it: secret-looking values replaced,
 * structure kept.
 *
 * The drafter needs the shape of the service -- which keys exist, how environment is
 * written -- not a database password. A value under a key that names a password, secret,
 * token, key or credential is replaced, unless it is only a reference (`${NAME}`), which
 * carries no secret; and the password part of any `scheme://user:pass@host` is replaced
 * wherever it appears. The applier still works on the real file.
 */
const LINE = /^(\s*-?\s*)([A-Za-z_][A-Za-z0-9_.-]*)(\s*[:=]\s*)(.+)$/
const SECRET_KEY = /(PASS|SECRET|TOKEN|KEY|CREDENTIAL)/i
const REFERENCE = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/
const URL_PASSWORD = /\/\/([^\s:@/]+):([^\s@/]+)@/g

export function redactSecrets(block: string): string {
  return block
    .split('\n')
    .map((line) => {
      let out = line
      const m = LINE.exec(line)
      if (m && SECRET_KEY.test(m[2]!)) {
        const value = m[4]!.trim().replace(/^(['"])(.*)\1$/, '$2')
        if (!REFERENCE.test(value)) out = `${m[1]}${m[2]}${m[3]}"<redacted>"`
      }
      return out.replace(URL_PASSWORD, '//$1:<redacted>@')
    })
    .join('\n')
}
