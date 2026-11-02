# Development setup

## Toolchain and installation

The repository pins Node **22.23.2** and pnpm **12.6.0**. Use Node 22 for the native SQLite ABI and the documented baseline. Git is required by source and secret checks. No database server, cloud account, Docker daemon, or model credentials are required for default development.

On a fresh checkout with `nvm` and Corepack available:

```sh
nvm install
nvm use
corepack enable
corepack prepare pnpm@12.6.0 --activate
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
```

If Corepack is absent, follow the [official pnpm installation instructions](https://pnpm.io/installation) and install the version in `package.json`. On Windows use your Node version manager and native `pnpm` commands; `scripts/pnpm` is a POSIX convenience wrapper.

This checkout has an ignored `.tools` directory containing a local pnpm copy and a Node 22 symlink. `./scripts/pnpm` selects these without changing the machine's global Node 24 installation. These paths are machine-local and are not part of a fresh checkout. Do not copy them to another machine.

Version selections live in `pnpm-workspace.yaml`; the lockfile pins every resolution, including the few type-package/tooling ranges in the catalog. pnpm 12 reads normal workspace settings from YAML; `.npmrc` contains registry configuration only. The store and cache are local ignored directories. Only explicitly allowed dependency build hooks run. `better-sqlite3` 13 includes native binaries, so its unnecessary implicit rebuild is disabled; the real database tests verify the binary works on the selected platform.

Do not hand-edit the lockfile. Its two YAML documents are pnpm's actual output, including its package-manager resolution. Do not use an older pnpm to rewrite it.

## Environment

Defaults work without an `.env` file. To override them, copy `.env.example` to `.env`; never commit credentials.

| Variable                   | Default / purpose                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                 | `development`; validated development/test/production mode                                               |
| `RIFF_HOST`                | `127.0.0.1`; loopback by default                                                                        |
| `RIFF_ALLOW_REMOTE`        | `false`; must explicitly be true before binding `0.0.0.0`                                               |
| `RIFF_PORT`                | `8787`; integer in 1–65535                                                                              |
| `RIFF_PUBLIC_URL`          | `http://localhost:5173`; future public console URL                                                      |
| `RIFF_SERVER_URL`          | `http://localhost:8787`; future server URL                                                              |
| `RIFF_DB_PATH`             | `./data/riff.db`; relative to the workspace root, including when started from the server package        |
| `RIFF_COMPILER_MODE`       | Only `mock` is accepted now; no compiler driver is activated                                            |
| `LOG_LEVEL`                | `info`; valid Pino level, including `silent` for tests                                                  |
| `RIFF_TRANSCRIPTION_MODE`  | empty → `openai` when `OPENAI_API_KEY` is set, else `off`; `mock` gives deterministic transcripts (F09) |
| `OPENAI_API_KEY`           | Optional; server-only key for push-to-talk transcription (`/v1/audio/transcriptions`)                   |
| `RIFF_TRANSCRIPTION_MODEL` | empty → `gpt-transcribe`                                                                                |
| `RIFF_API_TARGET`          | Vite-only proxy override; defaults to `http://127.0.0.1:8787`                                           |

The `RIFF_OBS_*` fields at the end of `.env.example` reserve future integration configuration; the transcription fields above enable optional push-to-talk. They are not consumed as active credentials in this foundation. Do not enable remote access for a public deployment: authentication, authorization and worker isolation are separate implementation gates.

Node reads `.env` for the server and migration commands; Drizzle Kit generation explicitly loads it from the repository root. Change `RIFF_API_TARGET` too if you change the host port during UI development. The Playwright configuration uses separate ports 4173/8788 and an ignored test database, without loading `.env`.

## Data and migrations

`apps/server/src/db/schema.ts` owns the schema. Review generated SQL and commit migrations and metadata together. Never edit an already committed migration.

```sh
./scripts/pnpm db:generate
./scripts/pnpm db:migrate
```

The initial migration creates only `channels`; future product tables remain planned. WAL, foreign keys and a bounded busy timeout are enabled. Real-file tests cover persistence, migration reapplication and close/reopen. The migration command reuses the host connection factory to create missing parent directories and closes the connection even on failure. Startup opens the configured database but does **not** automatically apply migrations; deployment orchestration must run them once before serving schema-dependent features. Shutdown closes the connection.

## Verification

```sh
./scripts/pnpm run doctor
./scripts/pnpm format:check
./scripts/pnpm check
./scripts/pnpm build
./scripts/pnpm check:bundles
./scripts/pnpm smoke
./scripts/pnpm browsers:install
./scripts/pnpm test:e2e
```

Vitest runs trusted host tests only. Test folders and fixtures reserved for generated/hostile automation code are excluded; future generated tests must run in the restricted guest runner. QuickJS tests now also exercise bounded private handlers, hostile probes, rolling quotas, replay isolation and atomic effect staging. Run `pnpm build:packages` before standalone runtime tests because the supervised worker runs compiled JavaScript.

Source checking remains strict. `skipLibCheck` skips third-party declaration checking because Drizzle's declarations reference optional drivers and contain internal type errors. It does not disable checking of Riff source or runtime inputs. DOM declarations are limited to browser code and the trusted QuickJS host's WebAssembly types; the SDK has no ambient Node or DOM types.

Browser tests require permission to bind local ports and launch Chromium. On Linux CI, use `pnpm --filter @riff/web exec playwright install --with-deps chromium`. A cached browser binary is not evidence that an E2E suite passed.

## Optional operations and creator tools

| Tool                                        | Installation / configuration                                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker Engine + Compose                     | Existing local engine or [official installation](https://docs.docker.com/engine/install/); Compose must work with that engine                |
| Gitleaks, Trivy, restic, Caddy, Compose CLI | macOS definitions in `infra/Brewfile`; `brew bundle --file=infra/Brewfile` installs machine-wide tools when needed                           |
| OBS Studio                                  | [Official download](https://obsproject.com/download); browser source and dock can be pointed at local URLs; no OBS control adapter is active |
| Streamer.bot / Firebot                      | Optional creator applications, using their supported operating systems; importing or running existing configurations is not implemented      |
| Prometheus / Grafana                        | Versioned images and datasource configuration under `infra/monitoring`; no application metrics dashboard exists yet                          |
| gVisor                                      | Conditional Linux hosted-worker isolation; not a macOS development dependency; needs dedicated compatibility/escape tests                    |
| GitHub / GHCR                               | A remote repository and permissions are required before CI runs or images are published; none is provisioned by setup                        |
| Twitch and model services                   | Developer applications, selected authorization and entitlement checks belong to their integration tasks                                      |

The Brewfile does not replace an existing Docker engine or install GUI applications automatically. Native browser Canvas, WebSocket, media APIs and Node crypto require no extra npm framework. SQLite is supplied through `better-sqlite3`, and the compiler CLI is project-local.

### Local container profile

```sh
./scripts/pnpm infra:validate
docker compose -f infra/compose.yaml build
docker compose -f infra/compose.yaml run --rm app node dist/migrate.js
docker compose -f infra/compose.yaml up
# Optional local HTTP proxy, on 127.0.0.1:8080:
docker compose -f infra/compose.yaml --profile proxy up --build
```

The application binds inside the container with explicit remote-interface consent; the host port remains loopback-only. It uses a named data volume, non-root user, read-only root filesystem, bounded scratch space and resource limits. This is a foundation verification image: it retains workspace development dependencies and is not the final minimal production image. Container builds, native Linux ABI, migrations, image scanning and digest pinning still need verification on a working Docker host. It is not an untrusted-code sandbox.

### Optional monitoring

```sh
# Set a unique RIFF_GRAFANA_PASSWORD in the terminal environment first.
./scripts/pnpm infra:monitoring
docker compose -f infra/monitoring/compose.yaml down
```

Monitoring is a separate Compose project so the default app setup needs no Grafana password. Prometheus currently scrapes itself. Configure the Riff metrics job only after an authenticated/bounded host metrics surface exists. Grafana and Prometheus bind to loopback ports 3000 and 9090. Passwords in Compose environments are visible to administrators of that Docker host.

For backups, create a consistent SQLite snapshot through the database API before restic archives it; do not copy a live `.db` file without its WAL state. Backup scheduling, retention, restores and secret storage remain implementation work in `infra/backups`.

## Troubleshooting

- Wrong Node version: use `nvm use` or this checkout's wrapper. Do not rebuild native packages using an unintended major.
- `pnpm doctor` runs the package manager's own diagnostics. Use `pnpm run doctor` for the project inventory.
- Missing registry access: existing modules can still run. A fresh dependency resolution or security audit needs the registry. Do not delete the lockfile or claim a blocked audit is clean.
- Offline restoration: this setup restored the previously installed lockfile from its local content-addressed cache with `--offline --frozen-lockfile --trust-lockfile`. That explicit local recovery skips metadata policy revalidation; normal installs and CI retain policy checks. It is not the recommended command for new or unreviewed dependencies.
- Local `EPERM` on listen or Docker socket: run the checks in a terminal/runner permitted to open local sockets. Fastify injection tests do not require sockets and remain useful, but do not replace browser or container verification.
