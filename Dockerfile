ARG NODE_BASE=node:24-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573

FROM ${NODE_BASE} AS build

WORKDIR /opt/lolbot

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_BASE} AS runtime

LABEL org.opencontainers.image.source="https://github.com/oxygengamestudio/LolBot" \
    org.opencontainers.image.description="LolBot Discord music bot Pterodactyl image"

ARG DEBIAN_FRONTEND=noninteractive
ARG BOT_BUILD_SHA=local
ARG YTDLP_VERSION=2026.07.04

ENV NODE_ENV=production \
    LOG_LEVEL=INFO \
    DATA_DIR=/home/container/data \
    BOT_BUILD_SHA=${BOT_BUILD_SHA}

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-venv tini \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp==${YTDLP_VERSION}" \
    && /opt/yt-dlp/bin/python -m pip uninstall --yes setuptools \
    && /opt/yt-dlp/bin/python -m pip uninstall --yes pip \
    && printf '%s\n' '#!/bin/sh' 'exec /opt/yt-dlp/bin/python -m yt_dlp "$@"' > /usr/local/bin/yt-dlp \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && rm -rf /var/lib/apt/lists/*

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
