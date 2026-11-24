import { getDb } from '../db.ts'

/** The Dockerfile of our own build watched through its base image, or null (compose/scan.ts). */
export function baseDockerfileFor(stack: string, service: string): string | null {
  const row = getDb()
    .prepare(`SELECT base_dockerfile FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { base_dockerfile: string | null } | undefined
  return row?.base_dockerfile ?? null
}


/** Whether the compose file runs our own build of this service's upstream image. */
export function isFork(stack: string, service: string): boolean {
  const row = getDb()
    .prepare(`SELECT fork_upstream FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { fork_upstream: string | null } | undefined
  return !!row?.fork_upstream
}


export function composeFileFor(stack: string, service: string): string | null {
  const row = getDb()
    .prepare(`SELECT compose_file FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { compose_file: string } | undefined
  return row?.compose_file ?? null
}


/** The service's `shipshape.deploy` label, as recorded by the last scan. */
export function deployLabelFor(stack: string, service: string): string | null {
  const row = getDb()
    .prepare(`SELECT deploy_label FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { deploy_label: string | null } | undefined
  return row?.deploy_label ?? null
}
