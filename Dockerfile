FROM node:24-bookworm-slim AS build

WORKDIR /opt/lolbot

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ARG DEBIAN_FRONTEND=noninteractive
ARG YTDLP_VERSION=2026.03.03
ARG YTDLP_SHA256=cc706b94cde1cf92cc155e3632aa290ab5f3809ada8c56c23311335508decdf9

ENV NODE_ENV=production \
    LOG_LEVEL=INFO \
    DATA_DIR=/home/container/data \
    YTDLP_AUTO_DOWNLOAD=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg tini \
    && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" -o /usr/local/bin/yt-dlp \
    && echo "${YTDLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/yt-dlp \
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
