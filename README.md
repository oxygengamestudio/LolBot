# LolBot

Bot Discord TypeScript de musique, bilingue FR/EN, deployable avec Docker, GitHub Actions et Pterodactyl.

## Requirements

- Node.js >= 22.12.0
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
| `BOT_OWNER_ID` | No | Optional Discord user ID with owner-level bypass. The legacy operator ID `189457295279783936` remains an explicitly accepted hardcoded bypass for this release. |
| `GOOGLE_API_KEY` | No | Optional Google/YouTube API key. If missing or quota-limited, the bot falls back to `yt-dlp`. |
| `GENIUS_CLIENT_ID` | No | Genius OAuth client ID. |
| `GENIUS_CLIENT_SECRET` | No | Genius OAuth client secret. |
| `DATA_DIR` | No | Base path for persistent bot data. Default: `./data` locally, `/home/container/data` in Pterodactyl. |
| `YTDLP_PATH` | No | Custom path to an installed `yt-dlp` binary. |
| `LOG_LEVEL` | No | Log verbosity (`ERROR`, `WARN`, `INFO`, `DEBUG`, `TRACE`). |

Legacy compatibility is kept temporarily:

- `CLIENT_ID` still works as fallback for `DISCORD_CLIENT_ID`
- `GUILD_ID` still works as fallback for `DISCORD_GUILD_ID`
- `YOUTUBE_API_KEY` still works as fallback for `GOOGLE_API_KEY`

Scope behavior:

- `DISCORD_COMMAND_SCOPE=auto`: if `DISCORD_GUILD_ID` is set, register guild commands and clear global commands; otherwise register global commands.
- `DISCORD_COMMAND_SCOPE=guild`: register guild commands only and clear global commands (requires `DISCORD_GUILD_ID`).
- `DISCORD_COMMAND_SCOPE=global`: register global commands and clear guild commands if `DISCORD_GUILD_ID` is set.

When a fallback is used, the app logs a deprecation warning.

## Local Preprod on Windows

Create `.env.preprod.local` from `.env.example`, fill the preprod Discord values locally, then run:

```bat
run-local-preprod.bat
```

The script checks Node.js/npm, installs dependencies when `node_modules` is missing, sets `BOT_ENV_FILE=.env.preprod.local`, and chooses the best startup command from `package.json`.

## Preprod Start (without GitHub)

Use VSCode Remote-SSH on your preprod host, then:

```bash
cp .env.example .env
# fill .env with preprod values (especially DISCORD_TOKEN)
npm ci
npm run typecheck
npm test
npm run dev
```

Optional slash command registration:

```bash
npm run register
```

## GitHub Deployment

The deployment split is branch-based:

- Push to `main`: build the prod image, push `ghcr.io/oxygengamestudio/lolbot:prod` and `:latest`, then restart the prod Pterodactyl server.
- Push to `pre-prod`: build the preprod image, push `ghcr.io/oxygengamestudio/lolbot:preprod`, then restart the preprod Pterodactyl server.

### GitHub repository configuration

Repository secrets:

- `PTERO_URL`
- `PTERO_CLIENT_API_KEY`
- `PTERO_PROD_SERVER_ID` for prod
- `PTERO_PREPROD_SERVER_ID` for preprod

The old `PTERO_SERVER_ID` secret is no longer used and can be deleted once `PTERO_PREPROD_SERVER_ID` exists.

## Pterodactyl

Inject secrets and config through environment variables in the panel. Do not store secrets in files committed to git.

This repository now ships a dedicated image and egg for panel deployment:

- Prod Docker image: `ghcr.io/oxygengamestudio/lolbot:prod`
- Preprod Docker image: `ghcr.io/oxygengamestudio/lolbot:preprod`
- Egg export to use for both servers: `pterodactyl/egg-lolbot.json`
- Startup command: `mkdir -p "$DATA_DIR" && node /opt/lolbot/dist/index.js`

See `PTERODACTYL.md` for the prod/preprod workflows, GitHub Secrets, and restart API setup.

The bot code is bundled inside the image under `/opt/lolbot`, while persistent runtime data goes through `DATA_DIR` (default `/home/container/data` in the egg). The image runs as a non-root user and does not copy `.env` into the build context.

Deployment readiness uses a fresh one-use challenge, the exact image build SHA, and the live Discord Ready state. If a Pterodactyl node does not expose its Wings WebSocket to GitHub, preproduction resolves `${DATA_DIR}/runtime-readiness.json` through the panel APIs and checks the private atomic 15-second receipt; no attestation secret is used.

The egg intentionally exposes only runtime-safe variables. `YTDLP_EXTRA_ARGS` stays blocked by default and requires `YTDLP_ALLOW_UNSAFE_EXTRA_ARGS=true` if you explicitly choose to allow arbitrary yt-dlp flags.
`DISCORD_TOKEN`, `GOOGLE_API_KEY`, and `GENIUS_CLIENT_SECRET` are hidden and read-only for panel sub-users.

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
