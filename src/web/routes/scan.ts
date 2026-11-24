import type { Hono } from 'hono'
import { isScanning, scanInfo } from '../../scan/index.ts'
import { runScanNow } from '../../scheduler.ts'
import { PhoneScan } from '../views/ui/shell.tsx'
import { ScanStatus } from '../views/ui/parts.tsx'
import { toastHeader } from '../render.ts'

/** The sidebar's scan chip, and the phone bar's clock out of band. */
const scanAnswer = (): string => {
  const lastAt = scanInfo().lastAt
  return (
    (ScanStatus({ running: isScanning(), lastAt }) as string) +
    (PhoneScan({ running: isScanning(), lastAt, oob: true }) as string)
  )
}

/** Start a scan, and the chip that shows one running. */
export function registerScanRoutes(app: Hono): void {
  /** The pending region alone, so it can refresh itself while a scan runs. */
  app.post('/scan', async (c) => {
    const result = await runScanNow()
    toastHeader(
      c,
      'info',
      result.status === 'already-running'
        ? 'A scan is already running.'
        : 'Scanning. The list refreshes itself as results come in.',
    )
    return c.html(scanAnswer())
  })

  app.get('/scan/status', (c) => c.html(scanAnswer()))
}
