# Foundation setup status

Recorded October 31, 2026. This describes the checked-out foundation, not completion of features F01–F40.

## Installed and verified

| Area                 | Result                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Toolchain            | Node 22.23.2 selected through the local wrapper; pnpm 12.6.0 installed locally; Git 2.54.0 available                                                                                                   |
| Dependencies         | 398 packages materialized; every declared direct dependency is present in all six workspaces and the root                                                                                              |
| Reproducibility      | Real pnpm lockfile committed; frozen offline restoration succeeded using the existing cache with explicit trust of that lockfile; fresh network installation/policy revalidation remains to be checked |
| Frameworks           | React 19.3.0, Vite 8.3.4, Tailwind 4.3.3, Fastify 5.12.7, TypeScript 5.9.3, Zod 4.6.7                                                                                                                  |
| Database             | better-sqlite3 13.0.3 native binary works; Drizzle ORM 0.45.4 / Kit 0.31.11; committed migration applies; real-file persistence and migration reapplication pass                                       |
| Runtime tooling      | QuickJS 0.32.0 loads WASM and disposes handles; compiler SDK and CLI 0.166.0 are present; CLI version probe passes                                                                                     |
| Supporting libraries | Fastify plugins, OBS client, transcription SDK, metrics client, WebSocket libraries, MSW, fast-check, Testing Library, Playwright and axe are installed in their owning workspaces                     |
| Source checks        | ESLint, package/source boundaries, strict types and formatting pass                                                                                                                                    |
| Tests                | 15 host/runtime checks and 15 workspace/boundary tooling tests pass                                                                                                                                    |
| Build                | Packages, server and three browser entries build; built overlay HTML has no scripts or console dependency                                                                                              |
| Smoke                | Real SQLite and Fastify HTTP injection pass; no network socket required                                                                                                                                |
| Secret scan          | Focused source scan and Gitleaks 8.30.1 scans of the source snapshot and committed history pass                                                                                                        |
| Browser tooling      | Playwright 1.64.0 discovers four E2E tests; matching Chromium v1248 executable is already cached                                                                                                       |

Installed Fastify plugins and client libraries are not all registered or invoked yet. The current HTTP surface is only `/api/health` and optional static files. UI elements describe the foundation; there are no functional approval or connection controls.

## Configured but pending environment verification

| Check / tool                      | Observed limitation and next action                                                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser / accessibility execution | The session denies binding `127.0.0.1:8788` with `EPERM`, before browser assertions run. Run `pnpm test:e2e` from a permitted terminal or CI. No browser-pass claim is made. |
| npm advisory audit                | Registry security endpoint DNS failed. Run `pnpm security:audit` with registry access; no clean-audit claim is made.                                                         |
| Docker                            | CLI 29.8.1 exists, but daemon/socket access is denied in the session. Compose is absent. Container builds, runtime health and image hardening remain unverified.             |
| Compose, Trivy, restic, Caddy     | Not installed as host executables. Optional macOS installation definitions are in `infra/Brewfile`; use them when enabling those operations.                                 |
| Monitoring                        | Prometheus 3.15.1 / Grafana 13.3.0 Compose templates and datasource are configured; images have not been pulled or started. Application metrics remain unimplemented.        |
| OBS / creator tools               | No GUI installation or connection was performed. OBS, Streamer.bot and Firebot require their supported local environment and later adapter implementation.                   |
| Hosted isolation / backups        | Responsibility folders and contracts exist; gVisor, restricted workers, backup jobs and restore drills are not implemented.                                                  |
| CI / registry                     | A workflow with pinned action revisions exists. No remote repository, CI run, GHCR push or deployment has occurred.                                                          |

The default development dependency setup is usable without those conditional operations tools. Full `setup:verify` remains pending until the browser environment permits execution. See [setup instructions](setup.md) for exact commands and [foundation decisions](decisions/0001-workspace-foundation.md) for tradeoffs and deprecated dependency follow-up.

## Fresh review

A fresh reviewer found two material setup defects. Both were reproduced before fixing: migration into a missing parent directory, and architecture checks missing TypeScript import types/network package subpaths. The migration command now shares the host's database opening/cleanup path; the checker inspects those import forms. Regression checks pass.

One minor documentation clarification is deferred: Vite reads `RIFF_API_TARGET` from the shell environment, while the server reads root `.env`. For a custom port, export the proxy target in the shell used to start development; setting it only in root `.env` does not configure the Vite proxy. Default ports work without changes.

The reviewer did not certify full product functionality, guest isolation, production packaging, browser/container execution, online advisories or live integrations. These remain the explicit implementation/environment gates above.

## Private preview increment — October 31, 2026

The earlier foundation inventory above is historical. The HTTP surface now also
includes `POST /api/preview`; the console renders private synthetic Tomato Toss
replay with real QuickJS execution, host-owned quotas, deduplication, version/seed
evidence and stop/reset controls. SDK 0.2.0 enables only projectile overlay output.
See [SDK.md](../packages/sdk/SDK.md) for limits and unsupported surfaces. Source
cannot be supplied over HTTP. Runtime generation and live activation remain pending.

A focused browser scenario is included for quotas, independent viewers, duplicates,
time advancement, accessibility and stop/reset. This session still denies the
Playwright server socket with EPERM, so no browser or visual-pass claim is made.
DOM tests cover stopped late responses and recoverable server errors.

Verification for this increment: 55 trusted host/runtime/DOM tests and 15 tooling
tests pass; lint, type checks, formatting, production build, bundle isolation and
Fastify/SQLite smoke checks pass. Browser execution remains blocked as described.
