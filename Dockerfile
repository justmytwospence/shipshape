FROM node:22-alpine

# git         -- all repository work (the tool shells out rather than using a JS git impl)
# docker-cli  -- deploys run `docker compose up -d` against the host socket. This is the
#                whole point of the tool: a TRUE compose up re-reads labels and image env,
#                which is exactly what WUD's clone-the-running-container recreate does not.
# sqlite      -- the docker-volume-backup archive-pre hook runs `sqlite3 .backup`.
RUN apk add --no-cache git docker-cli sqlite

# docker compose, pinned. Bump it on purpose, and dry-run every stack under the new
# version before shipping it.
#
# It used to be apk's `docker-cli-compose`, which made the version whatever Alpine carried
# on the day of the build. That drifted to 5.1.4 while the host ran 2.27.1, and 5.x refuses
# a healthcheck with `start_interval` but no `start_period` that 2.x quietly accepts. 29
# healthchecks carried exactly that, so every deploy shipshape attempted on those services
# failed -- crowdsec #71, minuspod #79 and #93 -- while the same file came up fine by hand.
# A version nobody chose is a version nobody checked.
#
# Copied from Docker's own image rather than pinned through apk: Alpine drops superseded
# package versions from its index, so an apk pin works until the day the build breaks.
COPY --from=docker/compose-bin:v5.5.1 /docker-compose /usr/libexec/docker/cli-plugins/docker-compose

WORKDIR /app

# better-sqlite3 ships prebuilds for musl/arm64+x64; build deps are only needed if the
# prebuild is missing, so install them in the same layer and drop them again.
COPY package.json package-lock.json* ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci \
    && apk del .build-deps

COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
RUN npm run build

# The live homelab checkout is bind-mounted at its own host path so that `docker compose`
# resolves relative volume paths and the project name identically to a host-side run.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

EXPOSE 8080

# git refuses to operate on a repo owned by another uid; the container runs as the host
# user (PUID/PGID) but the ownership check still needs an explicit exemption.
RUN git config --system --add safe.directory '*'

CMD ["node", "dist/index.js"]
