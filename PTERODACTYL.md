# Pterodactyl Preprod

This repository is set up for a Pterodactyl-first preprod deployment with a dedicated Docker image.

## Security note

The Discord preprod token and the Pterodactyl client API key that were pasted in chat must be treated as compromised. Revoke and regenerate them before starting the bot or configuring GitHub Actions.

Do not commit real values in `.env`, `.env.local`, `.env.preprod`, `.env.preprod.local`, docs, workflow files, or source code. Use Pterodactyl variables for runtime values and GitHub Secrets for CI/CD values.

## Docker image

GitHub Actions builds and pushes to GitHub Container Registry:

- `ghcr.io/oxygengamestudio/lolbot:preprod`
- `ghcr.io/oxygengamestudio/lolbot:${GITHUB_SHA}`

The image contains the built bot, Node.js, FFmpeg, and `yt-dlp`. Runtime secrets are not baked into the image. Make the GHCR package public, or configure registry credentials on the Pterodactyl node before using a private image.

After the workflow has run successfully, the package page will be under the GitHub organization packages:

```text
https://github.com/orgs/oxygengamestudio/packages/container/package/lolbot
```

## Pterodactyl server settings

Import the egg template:

```text
pterodactyl/egg-lolbot.json
```

Then create the server manually from the Pterodactyl panel using this egg. GitHub Actions only needs a client API key later to restart the existing server after a new image is pushed.

Use this Docker image:

```text
ghcr.io/oxygengamestudio/lolbot:preprod
```

Use this startup command:

```bash
mkdir -p "$DATA_DIR" && node /opt/lolbot/dist/index.js
```

Required runtime variables:

```text
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
```

Optional runtime variables:

```text
DISCORD_GUILD_ID=
DISCORD_COMMAND_SCOPE=auto
BOT_OWNER_ID=
GOOGLE_API_KEY=
GENIUS_CLIENT_ID=
GENIUS_CLIENT_SECRET=
DATA_DIR=/home/container/data
YTDLP_PATH=
YTDLP_AUTO_DOWNLOAD=false
LOG_LEVEL=INFO
```

`GOOGLE_API_KEY` is optional. When it is missing, expired, quota-limited, or rejected, the bot falls back to `yt-dlp` for YouTube search, direct URLs, and playlists.

## GitHub Actions secrets

Set these repository secrets:

```text
PTERO_URL=https://raynor.zerandia.fr
PTERO_CLIENT_API_KEY=<new regenerated client API key>
PTERO_SERVER_ID=<full server UUID or short identifier>
```

No Docker Hub secret is required for the preprod image workflow.

The restart step calls:

```text
POST /api/client/servers/{server}/power
{"signal":"restart"}
```

If `PTERO_SERVER_ID` is a full UUID, the workflow automatically uses the short identifier before calling the Client API.

## systemctl

This setup does not create `discord-music-bot-preprod.service`. In Pterodactyl-first mode, start, stop, and restart the bot from the Pterodactyl panel or the Pterodactyl API.

`systemctl` on the VPS is for the Pterodactyl node services such as Wings, not for this bot server directly.
