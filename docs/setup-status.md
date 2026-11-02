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

## Voice entry and aggregate insights (F09/F30) — November 1, 2026

F09 adds push-to-talk to Describe with hold/tap control, a level meter, a 60-second cap,
and an editable transcript review that never auto-submits. Permission-denied, no-device,
unsupported, not-configured, transcribing and failed-with-retry states are explicit.
`POST /api/voice/transcribe` accepts a bounded raw audio body behind the mutation guard
and calls OpenAI file transcription (`gpt-transcribe` by default) or a deterministic mock;
audio is never stored. The OpenAI transport is verified against the official guide and a
fake `fetch` only; no live key was exercised. Browser Web Speech fallback and real
microphone capture were not exercised in a real browser here (jsdom stubs only).

F30 adds `GET /api/insights` and a console Insights card computed from existing tables with
groups under three people suppressed and no per-viewer output. No migration or dependency.

Verification: 73 Vitest files / 775 tests passed (`vitest run --maxWorkers=4`; an unbounded
run under heavy machine load hit 20-second timeouts in pre-existing heavy tests, which pass
on re-run). Lint, strict types, formatting, build, bundle and focused secret checks passed.

## In-chat authoring and owner chat approval — November 1, 2026

F10/F17 add opt-in, broadcaster-only chat authoring (`!riff create|edit|approve|reject|
status|cancel`, `!approve` alias) over the existing compiler queue, verifier and exact
approval path, with short-lived single-use approval codes persisted in
`chat_authoring_state` (migration 0015). Helix Send Chat Message replies were implemented
from the documented request/response (fixture `helix.send-chat-message.json`) and tested
against fakes only; a real `user:write:chat` send to a live channel has not been
exercised. Tests cover badge/name/text spoofing, budget, fake-clock expiry, single use,
stale binding, lockout, panic invalidation, restart and the EventSub → Helix reply path.
See the [service contract](../apps/server/src/services/chat-authoring/README.md).

## Named timers (F18) — November 1, 2026

SDK capability `timer` (additive to 0.4.0) stages named one-shot or repeating timers
from generated handlers; the host persists them in the migration 0016 `timers` table,
fires them through the same engine admission, budgets and sandbox as chat, resumes
them on boot (≤30 s overdue fires once with `missed`, older fires are skipped and
logged) and cancels them on pause, panic, activation/rollback and quarantine. Preview,
generated scenarios and rehearsal run timers on private virtual clocks. The console
live panel lists pending timers with countdowns and cancellation; there is no overlay
countdown widget. Prompt pack `riff-compiler/7` and the offline compiler support
"every N minutes" and "in N seconds" requests. Timers inside stateful sessions remain
unsupported. Verified with Vitest service, route, sandbox, compiler and DOM tests; no
live Twitch stream or OBS rendering of timer fires was exercised.

## Channel Points and Predictions — F22, November 1, 2026

`points.redeem` maps to `channel.channel_points_custom_reward_redemption.add` v1 with a
doc-sourced fixture; Helix Create/Get/Update/Delete Custom Reward, Get/Update Redemption
Status and Create/Get/End Prediction are zod-parsed against documented examples (creations
are not retried on 5xx). Migration 0017 adds `channel_point_rewards`,
`channel_point_redemptions` and `prediction_requests`. Feature consent is requested per
panel; eligibility comes from Get Users `broadcaster_type`. SDK 0.4.0 adds the `predictions`
proposal capability (bridge, d.ts and validator in sync) and `trigger.kind`/`trigger.reward`.
Settlement of redemptions is host policy; settlement of predictions requires a confirmed
creator request. Verified with fixtures, fake Helix and a local EventSub WebSocket; no real
Affiliate channel, reward or prediction was exercised.

## Broader stateful mechanics (F31 definition version 2) — November 1, 2026

Implemented additive experience definition version 2 on the SDK 0.4.0 bridge: best-of-N
matches with per-round reset and intermission, team health pools with damage, healing and
elimination, distinct-viewer burst objectives on a sliding host-clocked window (with
optional shield), and score milestones that unlock tiers and locked commands. Seven new
decision codes, an independent hand-derived host suite, compatibility rules (any change
except labels or a longer break requires reset), four rehearsal presets, prompt pack
`riff-compiler/7` (merged with timers and Channel Points as `riff-compiler/9`), offline templates for four example intents with a recorded fixture,
and accessible HUD/scoreboard presentation (health meters, burst meter with window
countdown, round and break countdown, tiers). Version 1 definitions and identities are
unchanged. No tables, migrations, routes, env vars or dependencies were added.

Verification: 779 tests in 74 Vitest files pass (35 new across sandbox, compiler, server and web);
lint, boundary checks, strict types, production build and overlay bundle isolation pass.
Live server tests cover concurrent burst/damage admission, restart across a round
deadline, single round advancement and journal audit; no real-model version 2 compile or
live Twitch round is claimed.

Integration: version 2 mechanics actions ignore Channel Points redemptions exactly like
version 1 sessions, and F30 insights group the seven new mechanics codes under one
"Game rule" blocked reason.

## Non-game formats (F31 definition version 3) — November 2, 2026

Implemented additive experience definition version 3 on the SDK 0.4.0 bridge with one
declarative `format`: audience mural (`!paint <cell> <color>` on a bounded grid and host
palette, per-viewer paint allowance, optional final cells, live or end reveal), staged
music-composition vote (equal stage windows, one vote per viewer per stage, first-listed
tie-break, visual composition card without audio) and educational group challenge (`!a`–`!d`,
one final answer per question, reveal window with the creator's explanation, collective pass
mark, participation-only scores). Four decision codes (`INVALID_CHOICE`, `ALREADY_CHOSEN`,
`CELL_TAKEN`, `ANSWER_CLOSED`, grouped under the insights "Game rule" reason), an independent
host suite, reset/preserve compatibility rules, `paint`/`stages`/`answers` rehearsal presets,
prompt pack `riff-compiler/13`, offline templates with `fixtures/stateful-formats.json`, and
en/fr/es/de HUD, scoreboard and participation copy. No tables, migrations, routes, env vars or
dependencies were added. Not claimed: a real-model version 3 compile or a live Twitch round.

## Native Twitch polls, announcements and shoutouts — November 1, 2026

F21/F23 add Helix Create/Get/End Poll, Send Chat Announcement and Send a Shoutout
(verified against the Twitch API reference and Polls guide on November 1, 2026), the
`polls`, `chat.announce` and `shoutout` SDK capabilities, per-feature OAuth consent, the
`twitch_feature_state` table (migration 0018, renumbered from the branch's 0015 at merge) and a console **Twitch features** panel. Tests use msw and
doc-sourced fixtures; no live Twitch poll, announcement or shoutout was sent from this
environment. The raiders-only shoutout policy awaits an incoming-raid trigger.

Integration (prompt pack `riff-compiler/10`): one prompt carries the timer, Channel
Points, Predictions, version 2 mechanics and native-action rules. `/auth/twitch` accepts
both `?features=channel-points,predictions` and `?feature=polls|announcements|shoutouts`
and always keeps granted scopes. Native actions staged by a named-timer fire or a
Channel Points redemption are dispatched like chat-triggered ones (a fire-staged action
counts against the effect budget; sandbox test). Redemptions now also apply staged
timers and prediction proposals. Helix poll, announcement and shoutout mutations use
`{ retries: 0 }`.

## Sub, gift, resub, cheer and raid triggers (F19) — November 1, 2026

`packages/twitch/src/triggers.ts` adds `subscribe` (`channel.subscribe`), `gift`
(`channel.subscription.gift`), `resub` (`channel.subscription.message`), `cheer`
(`channel.cheer`) and `raid` (`channel.raid`, `to_broadcaster_user_id`), all version 1,
with versions, scopes and conditions checked against the EventSub subscription types page
on November 1, 2026. Fixtures are the documentation notification examples (inline `//`
comments removed). Normalization validates each payload with zod, hides anonymous
gifts/cheers behind one `anonymous` identity, clamps amounts and sanitizes resub/cheer
text and display names.

Manifests may declare `trigger.kind: 'twitch.event'` with `trigger.event {kind, minimum}`
and the reserved command `@kind` (SDK 0.4.0, additive; chat artifacts keep their identity). Events carry `event.twitch`
and enter the same engine admission (dedupe → kind → `BELOW_MINIMUM` → per-viewer window
→ channel budget) and live queue, durable admission records, panic fences and overlay path
as chat. Prompt pack `riff-compiler/7` (merged as `riff-compiler/11`) and the offline
compiler support event intents.
The Twitch connection subscribes on demand for families live interactions use when the
token carries the scope, and `GET /api/twitch/triggers` reports use, consent and
subscription state; `/auth/twitch?triggers=` requests extra consent while keeping earlier
scopes. Rehearsal and previews accept labeled synthetic Twitch events only.

Not verified here: delivery from a real Twitch channel (tests use the documented protocol
against a local WebSocket stand-in), and recipe export/adaptation of event-triggered
interactions (the recipe profile flow remains chat-command based). No new dependency,
table or environment variable.

Integration (prompt pack `riff-compiler/11`): F19 merged after F18/F21/F22/F31. The
shared `admit` loop keeps timer, prediction-proposal and native-action side effects for
chat and platform events; redemptions keep their own linked-automation path. The
manifest validator rejects a trigger that is both `points.redeem` and `trigger.event`.

Trigger unification (prompt pack `riff-compiler/12`): the manifest trigger is one
discriminated union on `trigger.kind` — `chat.command` (default when omitted),
`points.redeem` (requires `reward`) and `twitch.event` (requires `event`). Mixed triggers
cannot parse, and `matchesTrigger` routes each kind only to its own source. Chat and
Channel Points artifact identities are byte-identical to pack 11; the never-shipped F19
fixtures were regenerated with `kind: 'twitch.event'`.
Incoming raids feed F23's "raiders only" shoutout policy (`recordRaid`), and selecting
that policy subscribes to `channel.raid` on its own (server test). `/auth/twitch`
accepts `?features=`, `?feature=` and `?triggers=` together.
