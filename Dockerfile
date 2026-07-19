ARG NODE_BASE=node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

FROM ${NODE_BASE} AS build

WORKDIR /opt/lolbot

RUN apk add --no-cache build-base py3-setuptools python3

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_BASE} AS runtime

LABEL org.opencontainers.image.source="https://github.com/oxygengamestudio/LolBot" \
    org.opencontainers.image.description="LolBot Discord music bot Pterodactyl image"

ARG BOT_BUILD_SHA=local
ARG YTDLP_VERSION=2026.07.04
ARG TARGETARCH=amd64

ENV NODE_ENV=production \
    LOG_LEVEL=INFO \
    DATA_DIR=/home/container/data \
    BOT_BUILD_SHA=${BOT_BUILD_SHA}

RUN apk add --no-cache ca-certificates ffmpeg gcompat tini \
    && case "${TARGETARCH}" in \
        amd64) asset='yt-dlp_musllinux'; checksum='f7439ec2e3ffe69e06ac233f83f0d9687b89105939129bddcbf74e5de0f2b40e' ;; \
        arm64) asset='yt-dlp_musllinux_aarch64'; checksum='9a6a4de88f35dc68c1763945fbb417e092ebd9afc5d66052ac31b68d405a12a7' ;; \
        *) echo "Architecture yt-dlp non prise en charge: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && wget -q -O /usr/local/bin/yt-dlp \
        "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${asset}" \
    && echo "${checksum}  /usr/local/bin/yt-dlp" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
        /usr/local/bin/pnpm /usr/local/bin/pnpx

WORKDIR /opt/lolbot

COPY --from=build /opt/lolbot/package.json ./package.json
COPY --from=build /opt/lolbot/package-lock.json ./package-lock.json
COPY --from=build /opt/lolbot/node_modules ./node_modules
COPY --from=build /opt/lolbot/dist ./dist

RUN mkdir -p /home/container /opt/lolbot \
    && chown -R node:node /home/container /opt/lolbot

USER node

VOLUME ["/home/container"]

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
