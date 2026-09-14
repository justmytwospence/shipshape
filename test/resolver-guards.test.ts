import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFileUpstream,
  githubMentions,
  isPackagingRepo,
  looksInherited,
  nameRelation,
  ownerRelation,
  rankMentions,
  relation,
} from '../src/resolver/guards.ts'

/**
 * The judgement calls behind each inferred repository, on strings alone.
 */

test('names relate through punctuation and packaging words, not through short or generic ones', () => {
  assert.equal(relation('n8nio', 'n8n-io'), 'same')
  assert.equal(relation('crazymax', 'crazy-max'), 'same')
  assert.equal(relation('fail2ban', 'docker-fail2ban'), 'same')
  assert.equal(relation('beszel-agent', 'beszel'), 'close')
  // Three characters is not enough to say one name contains another.
  assert.equal(relation('n8n', 'n8n-hosting'), null)
  // Nor is a word half the images on Docker Hub contain.
  assert.equal(relation('server', 'nextcloud-server'), null)
  assert.equal(relation('glance', 'glances'), 'close')
  assert.equal(relation('minuspod', 'whisper'), null)
})

test('an image path relates to a repository by any segment after its namespace', () => {
  const signal = 'packaging/signal-cli/signal-cli-native'
  assert.equal(nameRelation(signal, 'AsamK/signal-cli'), 'same')
  assert.equal(ownerRelation(signal, 'AsamK/signal-cli'), null)
  assert.equal(nameRelation('ttlequals0/minuspod', 'ttlequals0/MinusPod'), 'same')
  assert.equal(ownerRelation('ttlequals0/minuspod', 'ttlequals0/MinusPod'), 'same')
  // `library` is nobody's GitHub account.
  assert.equal(ownerRelation('library/postgres', 'library/postgres'), null)
})

test('a namespace that is the project relates the image to it, below the image name', () => {
  assert.equal(nameRelation('vaultwarden/server', 'dani-garcia/vaultwarden'), 'close')
  const { ranked } = rankMentions('offen/docker-volume-backup', ['offen/offen', 'offen/docker-volume-backup'])
  assert.equal(ranked[0]?.repo, 'offen/docker-volume-backup')
  assert.ok(ranked[1]!.score < ranked[0]!.score, 'a unique best, not a tie')
})

test('a description yields the repositories it links, and nothing GitHub links for itself', () => {
  const text = [
    'Source: https://github.com/ttlequals0/MinusPod.git and [docs](https://github.com/ttlequals0/MinusPod/blob/main/README.md).',
    '[![CI](https://github.com/prometheus/node_exporter/actions/workflows/ci.yml/badge.svg)]',
    'Sponsor me at https://github.com/sponsors/ttlequals0 or see github.com/orgs/acme.',
    'API: https://api.github.com/repos/acme/api and https://gist.github.com/someone/abc123',
    'See also github.com/openai/whisper.',
  ].join('\n')
  assert.deepEqual(githubMentions(text), ['ttlequals0/MinusPod', 'prometheus/node_exporter', 'openai/whisper'])
})

test('n8n: the repository matching name and owner wins over the others its page links', () => {
  const mentions = ['n8n-io/localtunnel', 'n8n-io/n8n', 'n8n-io/n8n-hosting', 'linuxserver/docker-n8n']
  const { ranked, packaging } = rankMentions('n8nio/n8n', mentions)
  assert.equal(ranked[0]?.repo, 'n8n-io/n8n')
  assert.equal(ranked[0]?.confidence, 'high')
  assert.ok(ranked.slice(1).every((r) => r.score < ranked[0]!.score), 'a unique best')
  assert.deepEqual(packaging, ['linuxserver/docker-n8n'])
})

test('a link that relates to the image by nothing at all is not a candidate', () => {
  const { ranked } = rankMentions('ttlequals0/minuspod', ['openai/whisper', 'ttlequals0/MinusPod'])
  assert.deepEqual(ranked.map((r) => r.repo), ['ttlequals0/MinusPod'])
  // Only the name matching is a likely match, not a certain one.
  const signal = rankMentions('packaging/signal-cli/signal-cli-native', ['AsamK/signal-cli'])
  assert.equal(signal.ranked[0]?.confidence, 'medium')
})

test("an Official Image's packaging repository is not its source", () => {
  const nginx = rankMentions('library/nginx', ['nginx/docker-nginx', 'nginx/nginx'])
  assert.deepEqual(nginx.ranked.map((r) => r.repo), ['nginx/nginx'])
  assert.deepEqual(nginx.packaging, ['nginx/docker-nginx'])
  assert.deepEqual(rankMentions('library/redis', ['redis/docker-library-redis']).packaging, ['redis/docker-library-redis'])
  assert.deepEqual(rankMentions('library/mariadb', ['MariaDB/mariadb-docker']).packaging, ['MariaDB/mariadb-docker'])
  // Another image's packaging, linked from the same page, is not recorded as this one's.
  assert.deepEqual(rankMentions('library/postgres', ['postgis/docker-postgis']), { ranked: [], packaging: [] })
  // Anywhere else the word means nothing: offen's project is the image.
  assert.deepEqual(
    rankMentions('offen/docker-volume-backup', ['offen/docker-volume-backup']).ranked.map((r) => r.repo),
    ['offen/docker-volume-backup'],
  )
})

test("LinuxServer's build file names the upstream, when it reads one from GitHub", () => {
  assert.equal(buildFileUpstream(`    EXT_USER = 'Tautulli'\n    EXT_REPO = 'Tautulli'`), 'Tautulli/Tautulli')
  assert.equal(
    buildFileUpstream(`EXT_RELEASE = sh(script: '''curl -sX GET https://api.github.com/repos/coder/code-server/releases/latest''')`),
    'coder/code-server',
  )
  // Its own repository is not an answer.
  assert.equal(buildFileUpstream(`curl https://api.github.com/repos/linuxserver/docker-plex/releases`), null)
  assert.equal(buildFileUpstream(`EXT_RELEASE = sh(script: '''curl -s https://plex.tv/api/downloads/5.json''')`), null)
})

test('a config label is set aside when it plainly came from a base image', () => {
  assert.match(looksInherited({}, 'acme/widget', '1.4.2', 'docker-library/python') ?? '', /base images/)
  assert.match(looksInherited({}, 'acme/widget', '1.4.2', 'linuxserver/docker-baseimage-alpine') ?? '', /base images/)
  assert.match(
    looksInherited({ 'org.opencontainers.image.title': 'ubuntu' }, 'acme/widget', '1.4.2', 'acme/widget') ?? '',
    /describe ubuntu/,
  )
  assert.match(
    looksInherited({ 'org.opencontainers.image.version': '22.04' }, 'acme/widget', '1.4.2', 'acme/widget') ?? '',
    /version 22.04/,
  )
  // Its own labels, agreeing with the tag, are kept: the variant is not the version.
  assert.equal(
    looksInherited({ 'org.opencontainers.image.version': 'v2.96.17' }, 'ttlequals0/minuspod', '2.96.17-cpu', 'ttlequals0/MinusPod'),
    null,
  )
  // A rolling tag says nothing about the version, so it cannot disagree; a pin on a line
  // agrees with any release on that line.
  assert.equal(looksInherited({ 'org.opencontainers.image.version': '1.0.0' }, 'acme/widget', 'latest', 'acme/widget'), null)
  assert.equal(looksInherited({ 'org.opencontainers.image.version': '3.7.1' }, 'traefik/traefik', 'v3.7', 'traefik/traefik'), null)
  assert.match(
    looksInherited({ 'org.opencontainers.image.version': '3.6.9' }, 'traefik/traefik', 'v3.7', 'traefik/traefik') ?? '',
    /version 3.6.9/,
  )
})

test('packaging repositories are told apart narrowly', () => {
  assert.equal(isPackagingRepo('linuxserver/docker-code-server'), true)
  assert.equal(isPackagingRepo('docker-library/postgres'), true)
  assert.equal(isPackagingRepo('traefik/traefik-library-image'), true)
  assert.equal(isPackagingRepo('pi-hole/docker-pi-hole'), false)
  assert.equal(isPackagingRepo('linuxserver/Heimdall'), false)
})
