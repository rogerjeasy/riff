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

| Check / tool                      | Observed limitation and next action                                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser / accessibility execution | The session denies binding `127.0.0.1:8788` with `EPERM`, before browser assertions run. Run `pnpm test:e2e` from a permitted terminal or CI. No browser-pass claim is made.                                  |
| npm advisory audit                | Registry security endpoint DNS failed. Run `pnpm security:audit` with registry access; no clean-audit claim is made.                                                                                          |
| Docker                            | CLI 29.8.1 exists, but daemon/socket access is denied in the session. Compose is absent. Container builds, runtime health and image hardening remain unverified.                                              |
| Compose, Trivy, restic, Caddy     | Not installed as host executables. Optional macOS installation definitions are in `infra/Brewfile`; use them when enabling those operations.                                                                  |
| Monitoring                        | Prometheus 3.15.1 / Grafana 13.3.0 Compose templates and datasource are configured; images have not been pulled or started. Application metrics remain unimplemented.                                         |
| OBS / creator tools               | No GUI installation or connection was performed. OBS, Streamer.bot and Firebot require their supported local environment and later adapter implementation.                                                    |
| Hosted isolation / backups        | Responsibility folders and contracts exist; gVisor, restricted workers, backup jobs and restore drills are not implemented.                                                                                   |
| CI / registry                     | A workflow with pinned action revisions runs fast key checks only (format, lint, types, `test:ci`, tooling, secrets); full tests, build, e2e and audits run locally. No GHCR push or deployment has occurred. |

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

## Stateful experience increment — October 31, 2026

Implemented SDK 0.4 (0.3 compatible), canonical team-score and cooperative-goal rules,
host-owned resources and phase transitions, SQLite session/event/outbox transactions,
restart/deadline recovery, independent panic persistence, reset/version compatibility
fences, private replay and shared live/preview HUD. Migration 0002 creates the three
scoped session tables and durable identity indexes. No secrets or dependencies added.

Reference prompts run through the offline compiler and actual verifier, approval and
live host in integration tests. A real model compile was attempted in this session;
it failed before producing a candidate with workspace routing discovery failure.
No successful real-model stateful generation is claimed. Existing loopback restrictions
still block the two socket-based integration tests and Playwright server startup.

Stateful verification evidence: 201 available tests and 15 tooling checks pass;
lint, types, formatting, build, bundle isolation, smoke and redacted secret scans
pass. Full suite has the two previously documented socket-permission failures.
Fresh review findings for panic durability, postcommit delivery and overlay rotation
were reproduced with SQLite triggers/real services and fixed with regression tests.

## Intent-aware visual canvas — November 1, 2026

F35 now includes the bounded host scene contract, selected-object runtime generation,
immutable SQLite scene revisions (migration 0010), revision/digest approval, configuration
updates inside approved regions, inherited presentation, undo, and a keyboard/pointer
canvas editor. Canvas, quick proof, F34 playback/comparison and live use the same
trusted renderer and host-derived participation instructions. Mobile text pages at
readable size; effects are clipped to safe bounds. No new guest capability or dependency.

Final verification: **498 tests in 43 files passed**, excluding only the two existing
socket-dependent tests; **15 tooling tests passed**. Lint/boundaries, strict types,
formatting, production build, overlay bundle isolation, Fastify/SQLite smoke, focused
secret checks and a redacted Gitleaks source-snapshot scan passed.

The full-suite attempt encountered the existing `eventsub-ws.test.ts` socket EPERM
and `twitch-live.test.ts` timeout caused by the denied localhost listener. Four
stateful-workflow tests also exposed a fixed four-second polling assumption under
concurrent WASM load. That helper now observes actual completion with a bounded
15-second deadline; production timeouts and behavioral assertions are unchanged.
The final available-suite run includes all stateful workflow tests and passes.

The new `apps/web/e2e/visual-canvas.spec.ts` covers scene save/review/apply, contextual edits,
private effects, mobile/reduced-motion controls and axe. Execution was attempted but
server startup was denied at 127.0.0.1:8788 (EPERM). A separate headless Chromium
launch was also denied by macOS MachPort permissions. No browser/visual/axe pass,
real-model scene generation, or new real-Twitch execution is claimed.

Independent review identified five presentation defects: cross-scene text overlaps,
reset effects persisting, stale quick-proof timing, incorrect first-review baseline,
and rehearsal/live instruction mismatch. All five were corrected with regression
coverage. Scenes keep exact approved parent presentation when authoring descendants;
this carries presentation approval only, never behavior activation. Scene-only
requests cannot authorize behavior changes; those use the existing authoring workflow.

A later review in a separate local instance with two live interactions found these live problems:

- **Card coverage:** the audience card was stretched across the whole gameplay area, and
  effects flew underneath it.
- **Panel coverage:** the 400 × 200 text boxes were drawn as opaque panels across about
  40% of the screen. Stateless interactions showed an empty dark scoreboard.
- **Second interaction:** a second live interaction lost its instructions and scoreboard
  without warning, and both interactions' effects layers were hidden.
- **Dragging:** dragging the scoreboard sideways blanked the editor preview.

Fixes:

- **Panels:** they now hug their text, and empty panels draw nothing.
- **Shared space:** shared instructions merge, scoreboards relocate, and effects are
  clipped around other text instead of hidden. The audience card takes a compact free spot
  near an edge. Text overlap no longer blocks apply; protected-area collisions still do.
- **Editor:** drags clamp and re-home into the area they land in. Area grips, resize
  handles, Alt+arrow resizing and quick left/right layouts were added. Invalid drafts stay
  visible with named reasons, and save errors name the object at fault.
- **Placement:** the editor sits under the rehearsal, collapsed until the version is live.

The two-interaction case was checked visually in a separate local instance.

## Shared experiences across channels — November 1, 2026

F36 now connects independently operated Riff instances around one authoritative,
verified teamless cooperative round. The creator console includes role and public-field
agreements, expiring invitations, private receiver verification and synthetic preview,
exact digest approval, membership status, owner start/pause/resume, and local leave.
Role commands map to the same pinned cooperative action; roles have separate local
badge eligibility, channel-namespaced allowances and contribution totals. No claim is
made that this increment supports arbitrary multi-role mechanics or distributed writers.

Migration 0011 persists shared sessions, atomic source receipts and sealed local
connections. A30/A31 tests cover all-channel consent, original-source deduplication,
independent stores, field grants, local emergency stop, required-member departure,
lease expiry during execution, coordinator restart and explicit recovery. An integration
test uses two Fastify instances, separate SQLite databases and different encryption keys;
HTTP peer traffic is injected in-process. It is not a live two-creator Twitch demonstration.

The single final review identified three material issues, each reproduced and fixed:
public guidance changing under an unchanged digest, failed incident persistence allowing
execution to restart, and polling read errors escaping the local safety boundary.
Receivers now check approved public guidance exactly; quarantine precedes persistence;
local read failures synchronously withdraw output. Additional regressions cover uncertain
approval responses, local command conflicts and unchanged-overlay rehydration.

Browser validation includes eight DOM/boundary tests and a mocked protocol Playwright/axe
journey. Actual Chromium execution remains blocked: the Playwright web server cannot bind
127.0.0.1:8788 (`listen EPERM`). The two existing localhost socket tests retain the same
environment limitation. Deployment needs independently authorized Twitch connections,
RIFF_SECRET and a reachable HTTPS coordinator origin. Only `/peer` requires remote peer
access; creator endpoints retain the existing local-operator trust model.

Final verification on the reviewed source: 547 tests passed across 50 suites; only
`apps/server/test/twitch-live.test.ts` and `packages/twitch/test/eventsub-ws.test.ts`
failed because localhost listeners are prohibited (`EPERM`, with the former also
reaching its 30-second deadline). Lint, architecture boundaries, strict source/test
TypeScript, formatting, production build, overlay bundle isolation, Fastify/SQLite
smoke checks, 15 tooling tests and focused/redacted broad secret scans passed.
All changes remain uncommitted on main for owner review.

### Shared channels review — November 1, 2026

Two local instances were driven through create, owner approval, invitation, independent
review, approval, start, contributions from both channels, goal reached and restart.
The review found:

- **Chat blocking:** the channel chat pipeline waited for every coordinator round trip.
- **Status and errors:** waiting status never updated, and coordinator refusals reached the
  invited creator only as generic text.
- **Panel:** an unguided panel about 2,400 px tall with raw codes, JSON invitations and
  unexplained disabled buttons.
- **Overlay:** a plain card without a call to action, a goal meter or a smooth countdown.

All were fixed with regression tests, covering non-blocking input, live waiting reasons,
bounded message pass-through, partners, invitation codes, the host checklist and the stream
card. The one-line `riff-invite:` code was added; the raw JSON form is still accepted.
`RiffServices` now exposes `twitch` alongside the other services.

## Adaptive director (F37)

The console now supports draft → private synthetic burst → exact envelope approval
for host presentation pacing, visual intensity, interruption caps and visual
participation priority. Approved controls include gameplay focus, lock, manual
overrides and immediate presentation stop. Existing visual canvas regions remain
the protected-area authority. Behavior/eligibility edits still use version review.

The stress evidence records real sandbox scores and contributions alongside
cosmetic accounting; accepted gameplay survives coalescing. Restart preserves
approval and requires explicit resume. Delayed output rechecks live authority.
The gameplay queue rejects overflow visibly before counting it. See
[director implementation](../apps/server/src/services/director/README.md) for routes,
limits and ownership. Verification results for this increment are recorded in its
[implementation plan](superpowers/plans/2026-11-01-adaptive-director.md).

## Contextual remix and distribution (F38)

Creators can export licensed immutable editions, publish a playable synthetic demo,
import on another channel, adapt identity/language/layout/rules, inspect the diff and
install a verified candidate for normal local approval. The self-hosted `/recipes`
directory supports search, pinned downloads and reports; withholding and explicit
restoration remain operator actions. No central directory, external asset download,
identity certification or automatic update/activation is implied.

See the [recipe implementation](../apps/server/src/services/recipes/README.md) and
[verification record](superpowers/plans/2026-11-01-contextual-remix.md).

## Production setup and inclusive participation — November 1, 2026

F39 adds guarded host connections to authenticated OBS v5 and Streamer.bot, explicit
scene discovery, exact selected browser-source review, a diagnostic frame with visual
confirmation, live-source enablement and checked rollback. Named bot mappings can start
or pause an already approved current interaction and invoke a selected action at round
finish. Durable causal claims and quotas bound loops and replay. Panic fences the bridge
before cleanup. The dock now exposes the existing artifact evidence/approval controls.

F40 adds a public text companion at `/participate`, reviewed en/fr/es/de rule templates,
rate-limited `!riff help [language]`, durable broadcast preferences and independent device
preferences. High contrast, reduced motion and effect labels flow through protected scenes,
recipe exports, explicit recipient adoption and the existing verification/review pipeline.
No new dependency, Twitch scope, outbound chat message or guest capability is introduced.

Production setup requires `RIFF_SECRET` and authenticated endpoints reachable by the Riff
host. Hosted instances do not automatically reach a creator's localhost. Native Firebot
and Streamer.bot configuration migration remains unsupported; only strict versioned Riff
mappings are imported for review. Actual OBS pixels and Streamer.bot execution have not
been exercised here. The added Playwright narrow-screen/axe scenarios cannot start because
this environment rejects binding `127.0.0.1:8788` with EPERM. Socket-independent mocks and
DOM tests do not establish real-tool or browser usability. See the
[production contract](../apps/server/src/services/production/README.md) and
[participation contract](../apps/server/src/services/participation/README.md).

Verification for this increment: 685 tests in 66 socket-independent Vitest files and
15 tooling tests passed. Full lint, strict types, formatting, build, overlay bundle
isolation, SQLite/Fastify smoke, focused secrets and a redacted Gitleaks scan of changed
source files passed. Two existing socket-dependent test files were excluded from the
local run. CI includes the new production, participation and dock checks.

## Broader stateful mechanics (F31 definition version 2) — November 1, 2026

Implemented additive experience definition version 2 on the SDK 0.4.0 bridge: best-of-N
matches with per-round reset and intermission, team health pools with damage, healing and
elimination, distinct-viewer burst objectives on a sliding host-clocked window (with
optional shield), and score milestones that unlock tiers and locked commands. Seven new
decision codes, an independent hand-derived host suite, compatibility rules (any change
except labels or a longer break requires reset), four rehearsal presets, prompt pack
`riff-compiler/7`, offline templates for four example intents with a recorded fixture,
and accessible HUD/scoreboard presentation (health meters, burst meter with window
countdown, round and break countdown, tiers). Version 1 definitions and identities are
unchanged. No tables, migrations, routes, env vars or dependencies were added.

Verification: 779 tests in 74 Vitest files pass (35 new across sandbox, compiler, server and web);
lint, boundary checks, strict types, production build and overlay bundle isolation pass.
Live server tests cover concurrent burst/damage admission, restart across a round
deadline, single round advancement and journal audit; no real-model version 2 compile or
live Twitch round is claimed.
