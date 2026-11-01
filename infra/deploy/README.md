# Deploying Riff (AWS Lightsail, Terraform, Secrets Manager)

Every push to `main` that passes **Verify workspace** deploys automatically:

```
push to main → Verify workspace → Deploy workflow (.github/workflows/deploy.yml)
  1. terraform apply  infra/terraform/prod   (server, static IP, firewall, secrets)
  2. docker build     linux/amd64 image tagged with the commit
  3. infra/deploy/ship.sh → riffctl sync on the host (config from Secrets Manager)
  4. HTTPS health check of every streamer
```

GitHub assumes the AWS role `riff-github-deploy` through OIDC, so GitHub stores no AWS
keys. That role can only manage Lightsail, read and write `riff/prod/*` secrets, and use
its own state files. It cannot change IAM.

## What runs where

One small server runs one isolated Riff container per streamer, up to 5. Each streamer
gets their own database, secret, overlay key and subdomain. Caddy in front provides
automatic HTTPS (Let's Encrypt). Each app shows its own Riff sign-in page and keeps the
browser signed in with a 30-day HttpOnly session cookie.

```
https://<streamer>.<base-domain>
  ├─ /overlay, /assets, /ws/overlay   public (the overlay socket needs its key)
  ├─ /peer/*                          public (shared-channel bearer tokens)
  ├─ /api/health                      public
  └─ console, dock, API, /auth         need the streamer's sign-in (page or dock link)
```

| Path                                    | Role                                                                 |
| --------------------------------------- | -------------------------------------------------------------------- |
| `infra/terraform/account`               | GitHub deploy role. Applied by an administrator only.                |
| `infra/terraform/prod`                  | Server, static IP, ports, snapshots, secrets. Applied by CI.         |
| `infra/terraform/prod/terraform.tfvars` | The list of streamers.                                               |
| `infra/terraform/first-time.sh`         | One-time setup by an administrator.                                  |
| `infra/deploy/ship.sh`                  | CI: send the image, sync config from Secrets Manager, check health.  |
| `infra/deploy/riffctl`                  | On the host: `sync` (used by CI), `status`, `logs <name>`, `backup`. |
| `infra/deploy/known_hosts`              | Pinned SSH host keys; any other key aborts the deploy.               |
| `infra/deploy/bootstrap.sh`             | First boot of a new host (swap, Docker, directories).                |

| Secret                | Contents                                                                                                                                                            | Managed by                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `riff/prod/streamers` | Per streamer: `RIFF_SECRET`, console password (+ bcrypt) and sign-in token                                                                                          | Terraform (generated)                                                                   |
| `riff/prod/shared`    | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `RIFF_COMPILER_MODE` (`codex` or `mock`), `RIFF_COMPILER_EFFORT`, `RIFF_COMPILER_MODEL`, `OPENAI_API_KEY`, `ACME_EMAIL` | You (Terraform only creates it). Mirrors the integration settings of your local `.env`. |
| `riff/prod/deploy`    | SSH private key for the `riff-deploy` Lightsail key pair                                                                                                            | Uploaded once by `first-time.sh`                                                        |

## One-time setup

Run this in your own terminal. It asks you to confirm each Terraform plan, and asks for
the Twitch client ID and secret with the secret hidden:

```
AWS_PROFILE=wick-dev infra/terraform/first-time.sh
```

Then push to `main`. Nothing else is manual after this.

## Everyday changes

| Change                                       | What to do                                                                                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ship code                                    | Push to `main`.                                                                                                                                                            |
| Add or remove a streamer                     | Edit `streamers` in `infra/terraform/prod/terraform.tfvars` and push. A removed streamer's container stops; its data volume is kept.                                       |
| New password and sign-in link for a streamer | Push after `terraform -chdir=infra/terraform/prod apply -replace='random_password.console["name"]' -replace='random_password.access["name"]'`, or taint them the same way. |
| Change Twitch, OpenAI or compiler settings   | Update `riff/prod/shared` in Secrets Manager, then push or run the **Deploy** workflow. Secret edits alone do not trigger a deploy.                                        |

Each new streamer also needs `https://<name>.<base-domain>/auth/twitch/callback` added
as an OAuth Redirect URL of your Twitch application. Twitch allows up to 10.

## Streamer access

Passwords and sign-in tokens live in `riff/prod/streamers`:

```
AWS_PROFILE=wick-dev aws secretsmanager get-secret-value --secret-id riff/prod/streamers \
  --query SecretString --output text | jq '.rogerjeasy | {CONSOLE_PASSWORD, ACCESS_TOKEN}'
```

- **Console:** open `https://<name>.<base-domain>` and enter that password on the Riff sign-in
  page. **Sign out** is in the header.
- **OBS dock:** a Custom Browser Dock at `https://<name>.<base-domain>/dock/?access=<ACCESS_TOKEN>`.
  OBS can't answer a password prompt, so the link sets a 30-day sign-in cookie and removes
  the token from the address.
- **Overlay:** copy its URL from the console. It carries its own key, so it needs no login.

## Current deployment

| Item                 | Value                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| AWS profile / region | `wick-dev` (account 707938860881) / `us-east-1`                                                        |
| Instance             | `riff-prod`, `small_3_0` (2 GB RAM, 2 vCPU, 60 GB SSD), Ubuntu 24.04                                   |
| Static IP            | `riff-prod-ip` → 18.210.118.156                                                                        |
| Domain               | `*.18-210-118-156.sslip.io` (free; resolves to the static IP)                                          |
| Backups              | Daily SQLite backups at 05:30 UTC (14 kept per streamer) and Lightsail snapshots at 06:00 UTC (7 kept) |
| Cost                 | About $12/month instance + ~$1.20/month for 3 secrets + a few cents of snapshots                       |
| Debug access         | `ssh -i ~/.ssh/riff-lightsail ubuntu@18.210.118.156 riffctl status`                                    |

## Limits and notes

- **Size:** this setup suits a handful of invited streamers. Each container is capped at
  640 MB and 1 CPU.
- **Login model:** console access is a password or sign-in link, not a Twitch-account
  login. Open sign-up would need Twitch-based console login and stronger isolation for
  generated code (`infra/isolation`).
- **No host replacement:** Terraform will not replace the host (`prevent_destroy`), because
  that would discard every streamer's data. Changing the bundle or blueprint therefore needs
  a deliberate migration.
- **Lightsail and IAM:** Lightsail hosts cannot use IAM roles, so the host never calls AWS.
  CI reads secrets and pushes rendered config over SSH.

## Teardown

Remove `prevent_destroy` from `infra/terraform/prod/main.tf`, then run
`terraform -chdir=infra/terraform/prod destroy` and
`terraform -chdir=infra/terraform/account destroy`. Then delete the `riff-deploy` key pair
and the state bucket.
