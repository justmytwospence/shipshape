# syntax=docker/dockerfile:1

# Every image below is pinned by tag and digest, and each is a named stage rather than a
# `COPY --from=<image>`, because Dependabot (docker ecosystem) only bumps FROM lines.

# ---------------------------------------------------------------------------- build
#
# Runs on the builder's own platform, never under emulation: TypeScript, Tailwind and
# `npm ci` produce the same bytes for every target. The production node_modules is
# architecture-independent because its one native module, better-sqlite3 13, ships
# prebuilt binaries for glibc and musl on x64 and arm64 inside its npm tarball and picks
# the right one at runtime.
FROM --platform=$BUILDPLATFORM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: `npm ci` from a lockfile runs `node-gyp rebuild` for better-sqlite3
# (it carries a binding.gyp), and a binary compiled here would be for the build platform
# and would win over the prebuilt one at runtime. Nothing in the build needs a script:
# esbuild, Tailwind's oxide and lightningcss arrive as per-platform packages.
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
COPY public/ ./public/
# After the prune: the build fails if anything native other than better-sqlite3's
# prebuilt binaries reached node_modules (it would tie the image to the build platform),
# then better-sqlite3's C sources and the binaries for other systems are dropped (25 MB).
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
 && test ! -e node_modules/better-sqlite3/build \
 && test -f node_modules/better-sqlite3/prebuilds/linuxmusl-x64.node \
 && test -f node_modules/better-sqlite3/prebuilds/linuxmusl-arm64.node \
 && test -z "$(find node_modules -name '*.node' ! -path 'node_modules/better-sqlite3/prebuilds/*')" \
 && rm -rf node_modules/better-sqlite3/deps node_modules/better-sqlite3/src \
 && find node_modules/better-sqlite3/prebuilds -type f ! -name 'linuxmusl-*' -delete

# ------------------------------------------------------------- docker CLI and plugins
#
# Deploys run `docker compose` against the host's daemon -- a true `compose up` that
# re-reads labels and image env, which is the point of the tool. The CLI and its two
# plugins are pinned to the versions shipshape was tested against, copied from Docker's
# own images: a version nobody chose is a version nobody checked. Compose in particular
# has refused files an earlier release accepted (5.x rejects a healthcheck with
# `start_interval` but no `start_period`), so bump it on purpose and run
# `docker compose config -q` over your stacks with the new version first.
# Alpine's packages are not used for these: Alpine drops superseded versions from its
# index, so an apk pin works until the day the build breaks.
FROM docker:29.9.3-cli@sha256:5a7af0dcb0e46c803efe9b45371dd21cb500e5b4453250394ac6f06d49b6e6f1 AS docker-cli
FROM docker/compose-bin:v5.7.0@sha256:a4de4851b16f18634f74de66f126d5de65f7c5cb5a9502d67ab83e9a96041a70 AS compose
# buildx: a service with `build:` (one of your own images, or a fork) is built before it
# is brought up, and without buildx compose falls back to the classic builder, which
# cannot read BuildKit-only Dockerfiles.
FROM docker/buildx-bin:0.38.1@sha256:0b7d9e66e81dd1155639421b8342f9731f8bb67cb11b58663f938d9c6e9b6eef AS buildx

# -------------------------------------------------------------------------- runtime
FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5

# git    -- all repository work (shipshape shells out to git rather than reimplementing it)
# sqlite -- the sqlite3 CLI, so a backup job can take a consistent copy of the database
#           from inside the container: sqlite3 /data/shipshape.db ".backup /data/backup.db"
# tini   -- PID 1: forwards SIGTERM to node and reaps the processes git and docker leave
# npm is removed: the app never runs it, and a package manager in the image is only
# something for vulnerability scanners to report.
RUN apk add --no-cache git sqlite tini \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=compose /docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=buildx /buildx /usr/local/libexec/docker/cli-plugins/docker-buildx

WORKDIR /app
# Owned by root and not writable by the user the app runs as: shipshape never changes
# its own code, and nothing that compromises the process can either.
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules/
COPY --from=build /app/dist ./dist/
COPY --from=build /app/public ./public/
COPY LICENSE.md ./
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/shipshape-entrypoint

# /data holds the database, the work clone and docker's client state. Created here for
# the default user so a container without a mount still starts; mount it.
RUN mkdir -p /data && chown node:node /data

# HOME is /tmp so any uid (`user:` in compose) has a writable home, including under
# `read_only: true` with a tmpfs on /tmp. DOCKER_CONFIG is under /data so buildx's state
# persists and a private registry's config.json has a documented place:
# ./data/docker/config.json. Set it yourself if you move DATA_DIR.
# TINI_SUBREAPER keeps tini correct, and quiet, when compose's `init: true` puts docker's
# own init in front of it.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    HOME=/tmp \
    DOCKER_CONFIG=/data/docker \
    TINI_SUBREAPER=1

USER node
EXPOSE 8080
STOPSIGNAL SIGTERM

# /health answers 503 when the database cannot be read or the main loop has stalled.
# The start period covers the one-time compaction of a large database after an upgrade.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8080}/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/shipshape-entrypoint"]
CMD ["node", "dist/index.js"]

# Last, so a new version invalidates no layer above.
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
ENV SHIPSHAPE_VERSION=$VERSION \
    SHIPSHAPE_REVISION=$REVISION
LABEL org.opencontainers.image.title="shipshape" \
      org.opencontainers.image.description="Docker Compose image updates for a homelab kept in git: reads the changelog, ships what nothing holds back, deploys, verifies and rolls back." \
      org.opencontainers.image.source="https://github.com/justmytwospence/shipshape" \
      org.opencontainers.image.url="https://justmytwospence.github.io/shipshape/" \
      org.opencontainers.image.documentation="https://justmytwospence.github.io/shipshape/" \
      org.opencontainers.image.licenses="FSL-1.1-ALv2" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION"
