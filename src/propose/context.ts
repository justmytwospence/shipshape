import { execa } from 'execa'
import { parse as parseYaml } from 'yaml'

/**
 * Facts about the running deployment that the compose file alone does not state.
 *
 * A compose file says a service is on the `traefik` network; it does not say that
 * network is `172.20.0.0/16`. When an upstream tells you to set a trusted-proxy range,
 * the compose file cannot answer the question and the model has to guess. It guessed
 * `172.16.0.0/12` on the first real proposal here -- the documented Docker default,
 * and wrong for this host.
 *
 * Everything gathered here is structural: network names, subnets, and the names and
 * images of sibling services. No environment values, no secrets, nothing from `.env`.
 */

export interface DeployContext {
  /** Networks this service joins, with their actual subnets where discoverable. */
  networks: { name: string; subnet: string | null }[]
  /** Other services in the same file, so `depends_on` targets are not opaque. */
  siblings: { name: string; image: string | null }[]
}

export async function gatherContext(
  composeText: string,
  service: string,
): Promise<DeployContext> {
  let doc: Record<string, any>
  try {
    doc = (parseYaml(composeText) ?? {}) as Record<string, any>
  } catch {
    return { networks: [], siblings: [] }
  }
  const services = (doc.services ?? {}) as Record<string, any>
  const self = services[service] ?? {}

  const names = normaliseNetworks(self.networks)
  const networks = await Promise.all(
    names.map(async (name) => ({ name, subnet: await subnetOf(name) })),
  )

  const siblings = Object.entries(services)
    .filter(([n]) => n !== service)
    .map(([name, svc]) => ({
      name,
      image: typeof (svc as any)?.image === 'string' ? (svc as any).image : null,
    }))

  return { networks, siblings }
}

/** `networks:` is a list of names or a map keyed by name; both appear in real files. */
function normaliseNetworks(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((n): n is string => typeof n === 'string')
  if (raw && typeof raw === 'object') return Object.keys(raw as Record<string, unknown>)
  return []
}

/**
 * The network's real subnet, or null when it cannot be determined.
 *
 * Null is a fine answer -- it just means the model is told the subnet is unknown and
 * should have the operator confirm any value that depends on it. That is strictly
 * better than the silent guess this replaces.
 */
async function subnetOf(name: string): Promise<string | null> {
  const r = await execa(
    'docker',
    ['network', 'inspect', name, '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}'],
    { reject: false, timeout: 10_000 },
  )
  if ((r.exitCode ?? 1) !== 0) return null
  const out = String(r.stdout ?? '').trim()
  return out || null
}

/** Rendered into the prompt. Empty when nothing could be discovered. */
export function renderContext(ctx: DeployContext): string {
  const parts: string[] = []
  if (ctx.networks.length > 0) {
    parts.push(
      'Networks this service is on (real subnets from the running host — use these ' +
        'rather than a documented default when a setting needs an address range):',
      ...ctx.networks.map(
        (n) => `- ${n.name}: ${n.subnet ?? 'subnet unknown — have the operator confirm any value derived from it'}`,
      ),
    )
  }
  if (ctx.siblings.length > 0) {
    parts.push(
      '',
      'Other services defined in the same file (context only — you may not edit them):',
      ...ctx.siblings.map((s) => `- ${s.name}${s.image ? `: ${s.image}` : ''}`),
    )
  }
  return parts.join('\n')
}
