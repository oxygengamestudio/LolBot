# Pterodactyl Prod and Preprod

This repository is set up for Pterodactyl-first prod and preprod deployments with a dedicated Docker image.

## Branch deployment map

| Branch | Workflow | Image tag | Pterodactyl server secret |
| --- | --- | --- | --- |
| `main` | `.github/workflows/prod.yml` | `ghcr.io/oxygengamestudio/lolbot:prod` and `:latest` | `PTERO_PROD_SERVER_ID` |
| `pre-prod` | `.github/workflows/preprod-pterodactyl.yml` | `ghcr.io/oxygengamestudio/lolbot:preprod` | `PTERO_PREPROD_SERVER_ID` |

Both workflows use the same Pterodactyl panel URL and client API key. Only the target server ID changes.

## Security note

Any Discord token or Pterodactyl API key that was pasted in chat must be treated as compromised. Revoke and regenerate it before starting the bot or configuring GitHub Actions.

Do not commit real values in `.env`, `.env.local`, `.env.preprod`, `.env.preprod.local`, docs, workflow files, or source code. Use Pterodactyl variables for runtime values and GitHub Secrets for CI/CD values.

## Docker image

GitHub Actions builds and pushes to GitHub Container Registry:

- `ghcr.io/oxygengamestudio/lolbot:prod`
- `ghcr.io/oxygengamestudio/lolbot:latest`
- `ghcr.io/oxygengamestudio/lolbot:preprod`
- `ghcr.io/oxygengamestudio/lolbot:${GITHUB_SHA}`

The image contains the built bot, Node.js, FFmpeg, and `yt-dlp`. Runtime secrets are not baked into the image. Make the GHCR package public, or configure registry credentials on the Pterodactyl node before using a private image.

After the workflow has run successfully, the package page will be under the GitHub organization packages:

```text
https://github.com/users/oxygengamestudio/packages/container/package/lolbot
```

## Private GHCR access from Raynor

If the GitHub repository or package stays private, Wings on `raynor.zerandia.fr` must authenticate to `ghcr.io` before it can pull `ghcr.io/oxygengamestudio/lolbot:prod` or `ghcr.io/oxygengamestudio/lolbot:preprod`.

Create a GitHub personal access token for the node with package read access. For a private package linked to a private repository, use a token that can read packages and the private repository. Do not use a Discord token, Pterodactyl API key, or a token pasted in chat for this.

On `raynor.zerandia.fr`, add this under the existing `docker:` section in `/etc/pterodactyl/config.yml`:

```yaml
docker:
  registries:
    ghcr.io:
      username: "oxygengamestudio"
      password: "<GHCR_READ_PACKAGES_PAT>"
```

The same snippet is available in:

```text
pterodactyl/wings-ghcr-private.example.yml
```

Then restart Wings:

```bash
sudo systemctl restart wings
```

To verify the node can pull the private image:

```bash
echo '<GHCR_READ_PACKAGES_PAT>' | docker login ghcr.io -u oxygengamestudio --password-stdin
docker pull ghcr.io/oxygengamestudio/lolbot:prod
docker pull ghcr.io/oxygengamestudio/lolbot:preprod
```

Use the same egg for both servers, but select the matching Docker image per server:

- Prod server: `ghcr.io/oxygengamestudio/lolbot:prod`
- Preprod server: `ghcr.io/oxygengamestudio/lolbot:preprod`

GitHub Actions overwrites the matching tag on each successful push, then calls the Pterodactyl restart API. Wings should pull the configured image during server boot; if it keeps an older cached image, check the Wings logs and trigger a server reinstall or pull the image manually on the node.

If the Pterodactyl console shows this error, Wings has not loaded valid GHCR credentials yet:

```text
failed to pull "ghcr.io/oxygengamestudio/lolbot:prod" image ... unauthorized
failed to pull "ghcr.io/oxygengamestudio/lolbot:preprod" image ... unauthorized
```

Fix it in `/etc/pterodactyl/config.yml`; do not create a second top-level `docker:` block if one already exists. Add only the `registries:` part under the existing `docker:` block, then run `sudo systemctl restart wings`.

## Pterodactyl server settings

Import only this egg template:

```text
pterodactyl/egg-lolbot.json
```

Then create the prod and preprod servers manually from the Pterodactyl panel using this same egg. GitHub Actions only needs a client API key later to restart the existing server after a new image is pushed.

Use the Docker image that matches the server:

```text
prod:    ghcr.io/oxygengamestudio/lolbot:prod
preprod: ghcr.io/oxygengamestudio/lolbot:preprod
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
PTERO_PROD_SERVER_ID=<prod full server UUID or short identifier>
PTERO_PREPROD_SERVER_ID=<preprod full server UUID or short identifier>
```

No Docker Hub secret is required for these workflows.

Delete the legacy `PTERO_SERVER_ID` repository secret after `PTERO_PREPROD_SERVER_ID` is created. The workflows no longer read it.

The restart step calls:

```text
POST /api/client/servers/{server}/power
{"signal":"restart"}
```

If `PTERO_PROD_SERVER_ID` or `PTERO_PREPROD_SERVER_ID` is a full UUID, the workflow automatically uses the short identifier before calling the Client API.

## systemctl

This setup does not create `discord-music-bot-preprod.service` or `discord-music-bot-prod.service`. In Pterodactyl-first mode, start, stop, and restart the bot from the Pterodactyl panel or the Pterodactyl API.

`systemctl` on the VPS is for the Pterodactyl node services such as Wings, not for this bot server directly.
