# LolBot

Bot Discord TypeScript, 12-factor ready, deployable with Docker, Docker Compose, GitHub Actions and Pterodactyl.

## Requirements

- Node.js 24+ (recommended)
- npm
- FFmpeg
- yt-dlp

## Environment Variables

Use `.env.example` as template for local and preprod runs.

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | Yes | Discord bot token (prod or preprod). |
| `DISCORD_CLIENT_ID` | Yes | Discord application client ID. |
| `DISCORD_GUILD_ID` | No | Test guild ID for instant slash command sync. |
| `DISCORD_COMMAND_SCOPE` | No | Slash registration scope: `auto` (default), `guild`, or `global`. |
| `GOOGLE_API_KEY` | Yes | Google/YouTube API key. |
| `RIOT_API_KEY` | No | Riot API key. |
| `GENIUS_ACCESS_TOKEN` | No | Genius access token. |
| `GENIUS_CLIENT_ID` | No | Genius OAuth client ID. |
| `GENIUS_CLIENT_SECRET` | No | Genius OAuth client secret. |
| `NODE_ENV` | No | Runtime environment (`development`, `test`, `production`). |
| `LOG_LEVEL` | No | Log verbosity (`ERROR`, `WARN`, `INFO`, `DEBUG`, `TRACE`). |
| `DOCKER_IMAGE` | Yes (infra) | Docker Hub image name, for compose/CI (ex: `youruser/lolbot`). |

Legacy compatibility is kept temporarily:

- `CLIENT_ID` still works as fallback for `DISCORD_CLIENT_ID`
- `GUILD_ID` still works as fallback for `DISCORD_GUILD_ID`
- `YOUTUBE_API_KEY` still works as fallback for `GOOGLE_API_KEY`

Scope behavior:

- `DISCORD_COMMAND_SCOPE=auto`: if `DISCORD_GUILD_ID` is set, register guild commands and clear global commands; otherwise register global commands.
- `DISCORD_COMMAND_SCOPE=guild`: register guild commands only and clear global commands (requires `DISCORD_GUILD_ID`).
- `DISCORD_COMMAND_SCOPE=global`: register global commands and clear guild commands if `DISCORD_GUILD_ID` is set.

When a fallback is used, the app logs a deprecation warning.

## Preprod Start (without GitHub)

Use VSCode Remote-SSH on your preprod host, then:

```bash
cp .env.example .env
# fill .env with preprod values (especially DISCORD_TOKEN)
npm ci
npm run dev
```

Optional slash command registration:

```bash
npm run register
```

## Production Deployment (push main)

A push on `main` triggers `.github/workflows/prod.yml`:

1. Build Docker image from this repo.
2. Push to Docker Hub with tags:
   - `latest`
   - `${GITHUB_SHA}`
3. SSH into VPS and run in `/opt/discord-bot`:
   - `docker compose pull`
   - `docker compose up -d --remove-orphans`

### GitHub repository configuration

Repository variable:

- `DOCKER_IMAGE` (example: `yourdockerhubuser/lolbot`)

Repository secrets:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`
- `PROD_SSH_HOST`
- `PROD_SSH_PORT`
- `PROD_SSH_USER`
- `PROD_SSH_PRIVATE_KEY`

### VPS prerequisites

In `/opt/discord-bot`:

- `docker-compose.yml` from this repository
- a local `.env` file with runtime variables and `DOCKER_IMAGE`
- Docker + Docker Compose installed

## Docker Compose (prod)

```bash
docker compose pull
docker compose up -d --remove-orphans
```

The compose file uses:

- image: `${DOCKER_IMAGE}:latest`
- env_file: `.env`
- persistent volume: `./data:/app/data`

## Pterodactyl

Inject secrets and config through environment variables in the panel. Do not store secrets in files committed to git.

For a TypeScript deployment, keep build output in `dist/` and run:

```bash
node dist/index.js
```

If your panel runs install/build automatically, use an install step such as:

```bash
npm ci && npm run build
```

## Stress Test (Single Instance, Multi Guild)

Use this to estimate how many concurrent guild voice sessions one bot process can sustain.

1. Copy `scripts/stress-single-instance.example.env` and fill values.
2. Export env vars in your shell.
3. Run:

```bash
npm run stress:single
```

Main inputs:

- `STRESS_TARGETS=guildId:voiceChannelId:textChannelId,...`
- `STRESS_URLS=url1,url2,...`
- `STRESS_DURATION_SEC`
- `STRESS_RAMP_STEP_SEC`

Outputs:

- CSV metrics in `data/stress/`:
  - active targets/queues
  - CPU%
  - RSS/heap
  - event loop delay
  - p95 track start latency
- Summary text file with max active targets reached and error count.

## Security Reminder

- Never commit any token, API key, private key or `.env` file.
- Keep secrets only in environment variables (local `.env`, Docker/Compose env, Pterodactyl panel, GitHub Secrets).
- Rotate tokens immediately if a leak is suspected.
