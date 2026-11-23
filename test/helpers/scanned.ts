import type { ScannedService } from '../../src/compose/scan.ts'

/**
 * A `ScannedService` with every field at its empty value, so a test names only what it is
 * about and a field added to the type later is added here once rather than in every
 * fixture. Typed in full (no `Partial` return), so `tsc` over test/ catches drift.
 */
export function scannedService(
  over: Pick<ScannedService, 'stack' | 'service'> & Partial<ScannedService>,
): ScannedService {
  return {
    composeFile: `${over.stack}/docker-compose.yaml`,
    imageRaw: null,
    ref: null,
    labels: {},
    profiles: [],
    dormant: false,
    hasBuild: false,
    buildContext: null,
    watched: true,
    unwatchable: null,
    pattern: null,
    tagInclude: null,
    classLabel: null,
    snapshotLabel: null,
    backupJobLabel: null,
    sourceLabel: null,
    changelogLabel: null,
    reviewLabel: null,
    deployLabel: null,
    probePort: null,
    networkMode: null,
    proposeLabel: null,
    groupLabel: null,
    unknownLabels: [],
    legacyLabels: [],
    labelProblems: [],
    fork: null,
    base: null,
    ...over,
  }
}
