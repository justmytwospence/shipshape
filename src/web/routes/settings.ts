import type { Hono } from 'hono'
import { loadPolicy, policyFileState } from '../../config.ts'
import { getDb } from '../../db/index.ts'
import {
  NotifyTools,
  RulesList,
  SettingsForm,
  TestEmailResult,
  type SettingGroup,
  type SettingValue,
} from '../views/ui/settings.tsx'
import { rescheduleScan } from '../../scheduler.ts'
import { SettingsPage } from '../views/pages.tsx'
import { applySettings, savedText } from '../../settings/apply.ts'
import { currentValue, SECTIONS, SETTINGS } from '../../settings/defs.ts'
import { SECTION_PROSE } from '../../settings/prose.ts'
import { listModels } from '../../analyze/models.ts'
import { activeChannels } from '../../notify/index.ts'
import { configured as emailConfigured, send as sendEmail } from '../../notify/email.ts'
import { chrome } from '../render.ts'

/** After a refused save, a refused field shows what was submitted and why; the rest, the file. */
const settingGroups = (
  submitted: Record<string, string> = {},
  fieldErrors: Record<string, string> = {},
): SettingGroup[] => {
  const { policy } = loadPolicy()
  const value = (def: (typeof SETTINGS)[number]): SettingValue => {
    const error = fieldErrors[def.path]
    const v =
      error !== undefined && submitted[def.path] !== undefined ? submitted[def.path]! : currentValue(policy, def.path)
    return { def, value: v, changed: currentValue(policy, def.path) !== def.defaultValue, error }
  }
  const groups: SettingGroup[] = []
  for (const [title, tagline] of SECTIONS) {
    const defs = SETTINGS.filter((d) => d.section === title)
    // Rules has no fields: it is a read-only list under its own heading.
    if (defs.length === 0 && title !== 'Rules') continue
    groups.push({
      title,
      tagline,
      prose: SECTION_PROSE[title],
      items: defs.filter((d) => !d.advanced).map(value),
      more: defs.filter((d) => d.advanced).map(value),
    })
  }
  return groups
}

/** The sinks notifications go to, and the way to prove the mail path works. */
const notifyTools = () =>
  NotifyTools({ channels: activeChannels('decision'), sinks: loadPolicy().policy.notify.sinks.map((x) => x.type) })

/** Merged updates that will not move until someone presses Deploy. */
const readyToDeploy = (): number =>
  (getDb().prepare(`SELECT COUNT(*) AS n FROM deploys WHERE status = 'ready'`).get() as { n: number }).n

/**
 * The settings, as one page in pipeline order.
 *
 * Each section shows what changes what shipshape may do, and folds its tuning under
 * More -- with the longer explanation, which used to sit beside the fields and pushed
 * the decisions below the fold.
 */
export function registerSettingsRoutes(app: Hono): void {
  app.get('/settings', async (c) =>
    c.html(
      SettingsPage({
        groups: settingGroups(),
        models: await listModels(),
        readyCount: loadPolicy().policy.paused ? readyToDeploy() : 0,
        extras: { Notifications: notifyTools(), Rules: RulesList({ rules: loadPolicy().policy.rules }) },
        policyRel: policyFileState().rel,
        chrome: chrome(c),
      }) as string,
    ),
  )

  app.post('/settings', async (c) => {
    const form = await c.req.parseBody()
    const changes: Record<string, string> = {}
    for (const def of SETTINGS) {
      const v = form[def.path]
      if (typeof v === 'string') changes[def.path] = v
    }
    const result = await applySettings(changes)
    // A schedule change should not wait for the old schedule to fire before applying.
    if (result.ok && result.applied.includes('scan.cron')) rescheduleScan()
    const fieldErrors = result.ok ? {} : (result.fields ?? {})
    const k = Object.keys(fieldErrors).length
    // Sentences not tied to one field: a dirty file, a failed commit, a file that would not load.
    const other = result.ok
      ? []
      : result.errors.filter(
          (e) => !Object.keys(fieldErrors).some((p) => e.startsWith(`${SETTINGS.find((d) => d.path === p)?.label}: `)),
        )
    return c.html(
      SettingsForm({
        groups: settingGroups(changes, fieldErrors),
        models: await listModels(),
        readyCount: loadPolicy().policy.paused ? readyToDeploy() : 0,
        extras: { Notifications: notifyTools(), Rules: RulesList({ rules: loadPolicy().policy.rules }) },
        policyRel: policyFileState().rel,
        banner: result.ok
          ? result.applied.length
            ? { level: 'info', text: savedText(result.applied, result.commit) }
            : null
          : {
              level: 'error',
              text:
                k === 0
                  ? other.join(' ')
                  : `${k} ${k === 1 ? 'setting was' : 'settings were'} not saved; each says why below.${other.length ? ` ${other.join(' ')}` : ''}`,
            },
      }) as string,
    )
  })

  /**
   * Prove the mail path end to end.
   *
   * SMTP is the one piece of this that fails silently and for reasons nothing else can
   * observe -- a wrong port, a relay that refuses the sender, TLS that only works on 465.
   * A button that reports the server's own error beats reading logs after the fact.
   */
  app.post('/settings/email/test', async (c) => {
    if (!emailConfigured()) {
      return c.html(
        TestEmailResult({
          ok: null,
          text: 'SMTP_URL and MAIL_TO are not both set, so there is nothing to test.',
        }) as string,
      )
    }
    const r = await sendEmail({
      subject: 'shipshape: test message',
      text: 'If you are reading this, shipshape can send you email.\n\nSent from the Settings page.',
    })
    return c.html(
      TestEmailResult(
        r.ok ? { ok: true, text: 'Sent. Check the inbox.' } : { ok: false, text: r.error ?? 'failed' },
      ) as string,
    )
  })
}
