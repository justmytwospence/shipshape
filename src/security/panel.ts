import { loadPolicy } from '../config.ts'
import { securityStatus } from './loop.ts'
import { exposureViews, type ExposureView } from './queries.ts'

/** What the Status page shows of the security pass. */
export interface SecurityPanel {
  mode: 'off' | 'shadow' | 'on'
  autoMerge: boolean
  incidents: number
  withTargets: number
  images: number
  running: number
  uninventoried: number
  nextAt: string | null
  exposures: ExposureView[]
}

export function securityPanel(): SecurityPanel {
  const { policy } = loadPolicy()
  const s = securityStatus()
  return {
    mode: policy.security.mode,
    autoMerge: policy.security.auto_merge,
    incidents: s.incidents,
    withTargets: s.withTargets,
    images: s.inventories,
    running: s.running,
    uninventoried: s.uninventoried,
    nextAt: s.nextAt,
    exposures: policy.security.mode === 'off' ? [] : exposureViews(),
  }
}
