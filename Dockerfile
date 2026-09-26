ARG NODE_BASE=node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

FROM ${NODE_BASE} AS build

WORKDIR /opt/lolbot

RUN apk upgrade --no-cache && apk add --no-cache build-base py3-setuptools python3

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_BASE} AS runtime

LABEL org.opencontainers.image.source="https://github.com/oxygengamestudio/LolBot" \
    org.opencontainers.image.description="LolBot Discord music bot Pterodactyl image"

ARG YTDLP_VERSION=2026.08.19
ARG TARGETARCH=amd64

ENV NODE_ENV=production \
    LOG_LEVEL=INFO \
    DATA_DIR=/home/container/data

RUN apk upgrade --no-cache \
    && apk add --no-cache ca-certificates ffmpeg tini 'libcrypto3>=3.5.8-r0' 'libssl3>=3.5.8-r0' \
    && case "${TARGETARCH}" in \
        amd64) asset='yt-dlp_musllinux'; checksum='f3dec9cfeaf304cec98290fe41c6ad465d4b747d302473559643e7af24929722' ;; \
        arm64) asset='yt-dlp_musllinux_aarch64'; checksum='17b164c4d258be92bb1ad146cb7c336b783aedb380814aabbcb7d52937f77e57' ;; \
        *) echo "Architecture yt-dlp non prise en charge: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && wget -q -O /usr/local/bin/yt-dlp \
        "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${asset}" \
    && echo "${checksum}  /usr/local/bin/yt-dlp" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && printf '%s\n' '--js-runtimes node' > /etc/yt-dlp.conf \
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

ARG BOT_BUILD_SHA=local
ENV BOT_BUILD_SHA=${BOT_BUILD_SHA}

VOLUME ["/home/container"]

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
