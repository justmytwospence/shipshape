/**
 * Docker Official Images and a few vendors annotate their *packaging* repo. Mapping
 * those by hand is unavoidable -- there is no metadata anywhere that connects
 * `docker-library/postgres` to `postgres/postgres`.
 *
 * Kept short on purpose. An entry stays only while no other tier answers it with certainty
 * and names the same repository: `resolve-report --dry-run --without-overrides` is how to
 * tell. Removed so far, because their registry pages link them: n8n, actual, ntfy, beszel,
 * huginn, pi-hole, crowdsec, gotenberg. Entries for images no service here runs stay until
 * there is something to check them against.
 */
export const OVERRIDES: Record<string, string> = {
  'docker.io/library/postgres': 'postgres/postgres',
  'docker.io/library/redis': 'redis/redis',
  'docker.io/library/mariadb': 'MariaDB/server',
  'docker.io/library/nginx': 'nginx/nginx',
  'docker.io/library/traefik': 'traefik/traefik',
  'docker.io/library/nextcloud': 'nextcloud/server',
  'docker.io/library/influxdb': 'influxdata/influxdb',
  'docker.io/library/monica': 'monicahq/monica',
  'docker.io/library/mongo': 'mongodb/mongo',
  'docker.io/library/node': 'nodejs/node',
  'docker.io/library/telegraf': 'influxdata/telegraf',
  // Found without the map only as a likely match, or not at all.
  'docker.io/miniflux/miniflux': 'miniflux/v2',
  'docker.io/linkace/linkace': 'Kovah/LinkAce',
  'docker.io/nicolargo/glances': 'nicolargo/glances',
  'docker.io/grafana/grafana': 'grafana/grafana',
  'docker.io/organizr/organizr': 'causefx/Organizr',
  'docker.io/getmeili/meilisearch': 'meilisearch/meilisearch',
  'docker.io/valkey/valkey': 'valkey-io/valkey',
  // Found without the map, and wrongly: Tika's page links its packaging repo, and gluetun's
  // links someone else's copy.
  'docker.io/apache/tika': 'apache/tika',
  'docker.io/qmcgaw/gluetun': 'qdm12/gluetun',
  // No service here runs these, so nothing has checked them.
  'docker.io/traefik/traefik': 'traefik/traefik',
  'docker.io/crazymax/fail2ban': 'crazy-max/docker-fail2ban',
  'docker.io/getwud/wud': 'getwud/wud',
  'docker.io/netdata/netdata': 'netdata/netdata',
  'docker.io/prom/prometheus': 'prometheus/prometheus',
}

/** Tests only: the curated keys, which must be forms an image reference actually produces. */
export function overrideKeys(): string[] {
  return Object.keys(OVERRIDES)
}
