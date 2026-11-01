# AGENTS.md — Riff

Engineering contract for any agent or human working in this repository.

Riff is a live co-creation studio that compiles creator intent into sandboxed,
permission-scoped Twitch experiences. Codex is the compiler at runtime; the host
validates, sandboxes and executes. Product scope, including all nine approved studio
expansions and inclusive participation, lives in
[the project documentation](docs/project-documentation.md). Delivery layers indicate
dependencies, not timeframe-based feature cuts. Planned contracts are not claims of
implemented behavior.

The complete planned technology inventory and feature-to-tool mapping live in
[the technology stack](docs/tech-stack.md). Its decision labels distinguish the
existing baseline from supporting selections and conditional deployment tools.

The development foundation now exists; see [README](README.md),
[setup instructions](docs/setup.md), and [verified setup status](docs/setup-status.md).
Contracts for the full product below remain requirements, not implemented features.
The first complete describe → test → preview → approve → play workflow is implemented
(see "Current increment" at the end of this file). Contracts for the wider studio below
remain requirements, not implemented features.

When this file and your instincts disagree, this file wins. When this file and the
official Twitch or OpenAI docs disagree, the docs win — then fix this file in the same
change.

---

## 1. Architecture

```
apps/web            React + Vite: separate console, overlay and OBS dock entries
apps/server         Fastify HTTP + WebSocket; owns Twitch, compiler, sandbox, DB
packages/sdk        The Riff capability API: types, d.ts, docs and examples given to the compiler
packages/compiler   Codex driver: intent -> {automation.ts, automation.test.ts, manifest.json} | question
packages/sandbox    QuickJS (WASM) host: runs automations under limits through a capability bridge
packages/twitch     Helix client, EventSub WebSocket client, auth, recorded fixtures
```

Dependency direction is strictly downward:

```
apps/web  ->  (HTTP/WS only, no package imports from server)
apps/server -> packages/compiler, packages/sandbox, packages/twitch, packages/sdk
packages/compiler -> packages/sdk
packages/sandbox  -> packages/sdk
packages/twitch   -> (nothing internal)
packages/sdk      -> (nothing)
```

A package never imports from an app. `packages/sdk` has zero runtime dependencies.
Anything that talks to the network lives in `apps/server` or `packages/twitch` only;
inject the server-owned compiler transport into the compiler package. Production
adapters for OBS and other tools also live behind server-owned services.

One long-running server process (EventSub needs a persistent WebSocket). SQLite on
disk. Local development has no cloud dependency except Twitch and Codex.

### Stack (decided)

| Slot | Choice | Reason |
|---|---|---|
| Language / runtime | TypeScript 5, Node 22, pnpm workspaces, ESM everywhere | One language for host, SDK and generated code |
| Server | Fastify 5 + `@fastify/websocket` | Typed, small, fast |
| Web | React 19 + Vite + Tailwind 4 | Console and overlay in one app |
| DB | SQLite via `better-sqlite3` + Drizzle ORM + drizzle-kit migrations | Zero infra |
| Validation | `zod` at every boundary: HTTP bodies, Twitch payloads, Codex output, env | Fail closed |
| Sandbox | `quickjs-emscripten`; TypeScript AST instrumentation | WASM isolate: no fs/net, memory + CPU limits, no native build |
| Automation bundling | `esbuild` (IIFE, ES2020, `riff` external) | Deterministic and fast |
| Compiler | `@openai/codex-sdk`; fallback `codex exec --json --output-schema` | Codex is the runtime compiler |
| Tests | `vitest` for host code; in-sandbox runner for generated tests | Generated code is tested where it runs |
| Lint / format | ESLint 9 flat config + `typescript-eslint`; Prettier | One config at the root |

Do not add a framework, ORM, state library or UI kit beyond this table. New
dependencies need a one-line justification in the commit body.

Before using the Codex SDK, read its README in `node_modules/@openai/codex-sdk` and the
current Codex docs; do not code against a remembered API. Before every Twitch request
or payload type, check https://dev.twitch.tv/docs or a recorded fixture.

---

## 2. Boundaries

### 2.1 The SDK boundary (`packages/sdk`)

Generated automations may import only from `"riff"` and, in tests, `"riff/test"`.
The SDK is the complete universe the compiler sees. Rules for changing it:

- Every exported function has a doc comment with one example; `SDK.md` is generated
  from the d.ts and committed. The compiler prompt embeds `SDK.md` verbatim, so any
  undocumented surface is invisible to Codex and must not exist.
- Every capability has a name (`chat.say`, `overlay`, `timer`, `polls`, …) that
  appears in three places that must stay in sync: the d.ts, the host bridge in
  `packages/sandbox/src/bridge/`, and the host manifest validator in
  `packages/compiler/src/contract.ts`. A downstream integration test asserts the
  three sets are equal; never make the SDK depend on the compiler or sandbox.
  SDK types/constants stay dependency-free; Zod validation belongs downstream.
- Every external Twitch trigger maps to exactly one EventSub subscription type and
  version in `packages/twitch/src/triggers.ts`, with a sourced fixture under
  `packages/twitch/fixtures/<trigger>.json`. Internal timers, session transitions,
  rehearsal scenarios and authenticated production-adapter events are distinct
  normalized sources, never fabricated Twitch transport events.
- Capability calls that cause side effects (`chat.*`, `overlay.*`, `timer.*`,
  `polls.*`, `predictions.*`, `state.set`) return `Promise<void>` and are queued by
  the host; reads such as `state.get` and `users.role` return data. Atomic operations
  such as `state.incr` and `rate.allow` also return data but mutate host-owned state
  or counters; validate, budget and record them as mutations. Deterministic replay
  supplies recorded host observations rather than consulting current live state.
- Breaking changes to the SDK require a bump of `manifest.sdkVersion` and a
  compatibility note in `SDK.md`; old bundles keep running against the old bridge.

### 2.2 The sandbox boundary (`packages/sandbox`)

Non-negotiable invariants; each has a test in `packages/sandbox/test/invariants.test.ts`:

- One live QuickJS isolate per channel and automation version, created on activation
  and recreated after any trap. Every handler invocation gets a fresh execution
  context/module instance, disposed afterward; globals and closures never retain
  behavior-affecting state across events. Persist that state through the host API.
  Every preview or generated-test run uses a separate
  fresh runtime, even for the same bundle; never share the live heap, module globals,
  handles or mutable host state across modes or channels.
- Inside the isolate there is no network, no filesystem, no timers, no `eval`,
  no `Function`, no dynamic `import`, no `globalThis` mutation, no `Date.now`
  other than `ctx.util.now()`. The only host bridge is the `riff` object, which
  marshals JSON only (validated with zod on both directions).
- Limits: 64 MB memory, 50 ms CPU per handler call (interrupt handler), 2 s wall,
  25 capability calls per handler, 1 MB `state` per automation. Host-level caps per
  manifest field originate in the dependency-free SDK policy constants
  (currently `packages/sdk/src/index.ts`); compiler validators and sandbox enforcement
  import the same values without reversing package dependencies.
- On trap or limit breach: record an incident, disable that automation version,
  notify the console. Never auto-retry a trapped handler.
- Every capability call is checked in this order before execution: manifest lists
  the capability → automation limits → channel budget → host hard cap. The first
  failure rejects with a structured reason; the handler continues.
- Preview/rehearsal runs the identical behavior and bridge validation with separate
  state, clocks, rate windows, timers and simulated sinks for every side effect,
  including chat, overlays, collaboration and production adapters. Preview output is
  never routed to a live overlay. No separate preview behavior implementation.
- Generated code passes `packages/sdk/eslint.generated.js` before bundling: only
  `riff` imports, no `require`, no `with`, no unbounded `while`/`for(;;)`, regex
  literals ≤ 200 chars, no string literal > 500 chars.

### 2.3 The compiler boundary (`packages/compiler`)

- Input and output are zod schemas in `packages/compiler/src/contract.ts`. Output is
  read from `OUT.json` written by Codex in a fresh temp directory, never parsed from
  free text.
- The temp directory contains exactly: `riff.d.ts`, `riff-test.d.ts`, `SDK.md`,
  `examples/` (the six curated automations from `packages/sdk/examples`), `TASK.md`.
  The compiler receives no other repository material by design. A temporary
  directory alone cannot enforce read restrictions; verify the actual filesystem boundary.
- The trusted model transport needs approved network access. Generated tools/code
  receive no general network egress or credentials. Verify restricted reads, egress
  and sandbox options against the installed SDK and actual worker environment.
- The validation pipeline is a pure function of `(files, sdkVersion)` and runs in
  this fixed order: manifest schema → restricted lint → `tsc` against the d.ts →
  esbuild → in-sandbox tests against fixtures. Each stage returns a structured
  report; the first failure stops the pipeline.
- Exactly one automatic repair round per compile, via the same thread, with the
  failure report truncated to 4 KB. No silent retries beyond that.
- Hard timeout 180 s per compile; concurrency 1 per channel, 4 global; both are
  enforced in `packages/compiler/src/queue.ts`, not in route handlers.
- `RIFF_COMPILER_MODE=mock` replays recorded compile outputs from
  `packages/compiler/fixtures/` so the whole pipeline is tested in CI without Codex.
  Every new prompt-pack change must add or refresh a recorded fixture.
- Every compile run is persisted with thread id, attempt, stage reports, duration
  and token usage when the SDK exposes it. Logs are redacted (§4) before storage.

### 2.4 The Twitch boundary (`packages/twitch`)

- `helix.ts` is the only place that builds Helix requests. Every response is parsed
  with zod; unknown fields are allowed (`.passthrough()`), missing required fields fail.
- Retries only on 429 and 5xx, with jittered backoff and the `Ratelimit-Reset`
  header respected; never retry 4xx. Mutations (send message, create poll) are never
  retried after a timeout without an idempotency check.
- `eventsub.ts` owns the WebSocket lifecycle: `session_welcome`, `session_keepalive`
  (watchdog at 1.5× the announced timeout), `session_reconnect` (connect to the new
  URL before closing the old one), `revocation` (mark the subscription and surface an
  incident). Subscriptions are created against the session id. A Twitch-directed
  `session_reconnect` transfers existing subscriptions: keep the old connection
  until the new welcome arrives, and do not recreate subscriptions. After an
  unexpected disconnect, create a fresh session and recreate subscriptions.
  See https://dev.twitch.tv/docs/eventsub/handling-websocket-events/.
  Duplicate `message_id`s within 10 minutes are dropped.
- Subscription types and versions live in one table, `triggers.ts`, with a link to
  the doc page for each. When Twitch deprecates a version, change it there only.
- Fixtures are recorded from a real channel with `scripts/record-fixtures.ts`, ids
  replaced by stable fake values, and carry a `_source` field (recorded date or doc
  URL). Hand-written payloads are not allowed.
- Roles for `!riff` commands come from the EventSub badge set on the message, never
  from message text or display name.
- Tokens are encrypted at rest (AES-256-GCM, key from `RIFF_SECRET`) and refreshed
  proactively; refresh failures surface as an incident and pause the channel.

### 2.5 Server and data

- Routes in `apps/server/src/routes/*` only parse, authorize and call a service in
  `apps/server/src/services/*`. No Twitch, Codex or sandbox calls from a route file.
- Every channel-private table except `channels` carries `channel_id`; queries use
  `forChannel(channelId)`. Collaboration records carry coordinator owner-channel and
  session identity. Only a dedicated membership-aware repository may expose granted
  public projections across channels; generic repositories never bypass tenant scope.
- Schema lives in `apps/server/src/db/schema.ts`; changes go through drizzle-kit
  migrations committed under `apps/server/drizzle/`. Never edit a committed migration.
- Timers and KV are persisted (tables `timers`, `kv`) and resumed on boot; nothing
  that must survive a restart lives only in memory.
- Overlay WebSocket messages are versioned (`{ v: 1, type, payload }`) and validated
  on both ends; the overlay ignores unknown types instead of failing.

### 2.6 Web

- Console and overlay share components but never share state; the overlay is a
  separate entry with no interactive login and no console code in its bundle.
  Future live delivery requires a scoped, rotatable overlay bearer key. Verify Vite
  output manifests and HTML; the foundation uses `pnpm check:bundles` after build.
- Overlay performance budget: transparent background, 1920×1080 safe area, 60 fps on
  an integrated GPU, canvas for particle effects, CSS transforms only (no layout
  thrash), no network calls other than its WebSocket.
- Console: keyboard reachable, visible focus, `prefers-reduced-motion` respected,
  all async states (compiling, testing, preview, live, disabled, failed) explicit.
- Assets under `apps/web/public` must be ours or CC0, listed in `apps/web/public/CREDITS.md`.

### 2.7 Expanded studio contracts

The product documentation §§6.4–6.14, 9.4, 10.6, 14.7–14.8 and 15.4 define the
approved scope and proposed contracts. Implement them in the existing package
structure, keeping app services responsible for external I/O and authorization.

- A canonical, versioned experience definition unifies behavior, scene/timeline,
  state schema, participant rules, director envelope, tests and provenance. Visual
  and text edits revise this same representation; stale revisions conflict visibly.
- Session state and semantic gameplay admission are separate from cosmetic queues,
  credentials and host abuse counters. State/outbox transitions commit atomically.
- Live migrations run in bounded effect-free isolates; validate current state at
  the approved boundary before atomically activating. Rollback preserves compatible
  current progress or requires explicit reset; it never silently restores old scores.
- Audience proposals and ballots cannot authorize compilation or activation. Use
  moderated, creator-selected briefs, bounded quotas and idempotent vote accounting.
- Rehearsal uses explicit input provenance, seed, clock and initial snapshot.
  Snapshots include random cursor and replay-relevant host state; event-time host
  observations are recorded so replay never substitutes current external values.
  Synthetic scenarios stay labeled; counterexamples are retained as regression cases.
- Collaboration uses one authoritative coordinator and a separate shared-session
  runtime. It exposes only approved projections through each receiving channel's
  broker. No channel heap, private store or token is shared. Required-member loss
  pauses the session; local emergency stop remains independent and immediate.
- Director decisions remain within approved ranges, preserve accepted gameplay
  contributions, and explain their effects. Changes outside those ranges require
  version review; competitive-rule changes follow the live transition protocol.
- Remix preserves license and lineage, exposes capability/semantic differences,
  excludes private data, and requires recipient validation and approval.
- Production adapters authenticate origins, allowlist targets/actions, retain
  credentials in the host, and stop loops using causal metadata, hop limits and
  idempotency. Configuration import never executes arbitrary imported scripts.
- Free chat participation, explicit language preferences, late-arrival guidance,
  accessible presentation and tested fairness policies apply throughout the studio.

---

## 3. Testing policy

- **TDD for host code.** Write the failing `vitest` test first, make it pass, refactor.
  A change without tests is not done.
- Test pyramid per package:
  - `packages/sdk`: schema tests, capability-set sync test, example automations pass
    their own in-sandbox tests.
  - `packages/sandbox`: invariant tests (every bullet in §2.2), limit tests with
    deliberately hostile automations under `test/hostile/`.
  - `packages/compiler`: contract tests with `RIFF_COMPILER_MODE=mock`; pipeline stage tests;
    one future opt-in `pnpm test:compiler:live` suite that calls the real Codex (never in CI).
  - `packages/twitch`: Helix client against `msw` handlers built from fixtures;
    EventSub client against a fake WebSocket server exercising welcome, keepalive
    timeout, reconnect and revocation.
  - `apps/server`: route tests with Fastify `inject`, service tests with an in-memory
    SQLite file, one end-to-end `scripts/smoke.ts` that boots the server, emits
    fixtures and asserts overlay and chat calls.
- Generated automations must ship at least three tests: happy path, a limit or role
  edge, and a negative (unrelated event does nothing). The validator rejects fewer.
- Expanded features must satisfy their corresponding A22–A36 scenarios in the
  product documentation, including migrations, rehearsal, canvas consistency,
  proposal authorization, collaboration grants, director fairness and adapter loops.
- Coverage is not a target; invariants are. Each invariant in §2 has a named test.
- Flaky tests are fixed or deleted the same day; `retry` is not a fix.

---

## 4. Security rules

- Secrets only from environment variables. `.env` is git-ignored; `.env.example`
  lists every variable with a comment. The focused `scripts/check-secrets.mjs` scan checks recognizable credential
  patterns without treating public integrity hashes as secrets. Gitleaks supplies
  the broader scan; release checks must include both.
- Logs never contain tokens or cookies: a single redaction function in
  `apps/server/src/log.ts` strips `Authorization`, `access_token`, `refresh_token`
  and `Set-Cookie`. Compile logs pass through it before persistence.
- Session cookie: httpOnly, SameSite=Lax, Secure in production, signed with
  `RIFF_SECRET`. CSRF token on every mutating route.
- Overlay key: 128-bit random, URL-safe, rotatable; rotation invalidates old sockets.
- Viewer-supplied text is length-capped (500 chars) and stripped of control
  characters before it reaches an automation or any Helix call; never interpolated
  into URLs or SQL (Drizzle parameterizes; no raw SQL with user input).
- Channel budgets (chat, announcements, overlay effects per minute) are enforced
  host-side regardless of manifests. Exceeding one disables the noisiest automation
  and records an incident.
- Panic (`!riff panic`, console button) disables all automations, cancels timers,
  clears the overlay, and requires explicit confirmation to resume. It must work
  even when the compiler, DB write path or Twitch API is degraded: it flips an
  in-memory flag first and persists second.
- Compiler workspaces: restricted guest/tool reads and egress, separate trusted model
  transport, no inherited credentials, and deletion after the run. Test boundaries.
- Dependencies: `pnpm audit --prod` is clean at submission; lockfile committed.

---

## 5. Coding conventions

- ESM, `"strict": true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
  No `any` outside test doubles; `unknown` plus zod at boundaries.
- Errors are typed: `RiffError` with a `code` (`TWITCH_REJECTED`, `LIMIT_EXCEEDED`,
  `COMPILE_FAILED`, `SANDBOX_TRAP`, …), a user-safe `message`, and `detail` for logs.
  User-visible messages say what happened and what to do; stack traces never reach
  the UI.
- Naming: files kebab-case, types PascalCase, functions camelCase, env vars
  `RIFF_*` / `TWITCH_*`; preserve required upstream API identifiers. Capability and trigger names are dotted
  lowercase and are stable identifiers (they appear in manifests and prompts).
- Functions do one thing; prefer pure functions and pass dependencies explicitly
  (no module-level singletons for DB, Twitch or Codex clients; a `createApp(deps)`
  factory wires them).
- Comments explain why, not what. `// UNVERIFIED:` marks any Twitch/Codex detail
  not checked against docs or fixtures; CI counts them and the count must be 0
  at release.
- Keep generated-code examples in `packages/sdk/examples` idiomatic and minimal;
  Codex imitates them.

---

## 6. Git and delivery discipline

- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`),
  one green vertical slice per commit. Never commit red tests.
- Never add a `Co-Authored-By` trailer or a "Generated with …" line to any commit
  message or PR description.
- Work in small vertical slices that end with something runnable. Run
  `pnpm lint && pnpm typecheck && pnpm test` before claiming anything is done, and
  include the output summary in the final message of the task.
- Do not invent API shapes, flags or SDK methods. If it cannot be verified, say so,
  mark it `// UNVERIFIED:`, and keep going.
- Keep this file true: adding a capability, trigger, effect, env var, script, route
  or table means updating the matching section here in the same change.
- Ask at most one clarifying question per task and only when the answer changes what
  gets built; otherwise decide, state the decision in the commit body, continue.

---

## 7. Repository layout and commands

The six workspace roots above are implemented. Feature responsibility directories
and their READMEs reserve all approved studio capabilities. [README.md](README.md)
lists the actual layout and runnable commands; [docs/setup.md](docs/setup.md)
explains installation, environment variables and optional operations.

Current commands (use `./scripts/pnpm` for this checkout's local toolchain):

```text
pnpm dev              server (:8787) and web (:5173)
pnpm build            packages, server and three browser entries
pnpm test             trusted host, runtime, private replay and DOM tests
pnpm test:ci          fast key subset run by CI (contracts, sandbox boundary, host guards)
pnpm test:tooling      workspace graph and source-boundary tests
pnpm test:e2e          Chromium/axe checks; requires local sockets
pnpm lint             ESLint plus architecture boundary enforcement
pnpm typecheck        strict source checks in all six workspaces
pnpm check:bundles    inspect production entries after build
pnpm smoke            Fastify injection and SQLite foundation smoke test
pnpm db:migrate       apply committed Drizzle migrations
pnpm db:generate      generate migrations after a schema change
pnpm check            lint, types, host/tooling tests and focused secret scan
pnpm compile:live     one real Codex compile (+ --edit) through the full pipeline; never in CI
pnpm run doctor       tool and dependency inventory (explicit run avoids pnpm built-in)
```

`RIFF_COMPILER_MODE` is `mock` (deterministic offline template compiler, labelled in
the UI, used by CI and e2e) or `codex` (Codex SDK at runtime). `.env.example` is the
configuration inventory; `apps/server/src/env.ts` validates it (loopback binding,
explicit remote consent, ≥32-char `RIFF_SECRET`, Twitch app credentials, optional
EventSub/Helix overrides for the Twitch CLI mock, and hosted console sign-in via
`RIFF_CONSOLE_PASSWORD` (≥16 chars) and `RIFF_CONSOLE_ACCESS_TOKEN` (≥32 chars)). When a
password is set, `routes/session.ts` gates `/api/*`, `/ws/console` and `/auth/*` behind a
signed HttpOnly, SameSite=Lax session cookie (Secure over HTTPS, 30 days, key derived from
`RIFF_SECRET` and the password). `/api/health`, `/api/session*`, `/ws/overlay`, `/peer/*` and
static files stay public. `POST /api/session/login` is rate-limited, and `?access=<token>` on
any GET trades the dock link for a session. Unset, the console stays open for local use.
Migrations run at server boot.
Tables: `channels`, `channel_state`, `automations`, `versions`, `compile_runs`, `activity`,
`experience_sessions`, `session_events`, `session_outbox`, `session_journal`,
`admission_events`, `session_transitions`, `proposals`, `proposal_contributors`,
`proposal_history`, `proposal_grants`, `proposal_credit`, `proposal_receipts`,
`proposal_ballots`, `proposal_ballot_options`, `proposal_votes`, `proposal_selections`,
`proposal_generation_runs`, `rehearsal_scenarios`, `rehearsal_runs`,
`rehearsal_regressions`, `scene_heads`, `scene_revisions`.

---

## 8. Definition of done (per task and for release)

Per task:
- Tests written first and green; `pnpm check` green locally.
- No new `UNVERIFIED` markers unless named in the final message.
- This file updated if the task touched anything it describes.

For release:
- `git clone` → `pnpm i` → copy `.env.example` → `pnpm dev` works from the README alone.
- `pnpm check` and `pnpm smoke` green; zero `UNVERIFIED`; `pnpm audit --prod` clean.
- Every invariant in §2 has a passing named test.
- README documents architecture, environment, commands, and how to run and record
  fixtures.

## Current increment — describe → test → preview → approve → play

Implemented end to end, with Tomato Toss as the reference interaction:

- **SDK 0.3.0** (`packages/sdk`): chat events, permission manifest, `overlay` projectile
  capability (tomato/star/heart), decision codes, allowance snapshots, live/preview
  modes, declarative scenario tests, `SDK_GUIDE` (= committed `SDK.md`, sync-tested),
  `RIFF_DTS`, curated examples. Command matching is trimmed and case-insensitive.
- **Sandbox** (`packages/sandbox`): one warm worker per engine with the QuickJS module
  loaded once and a brand-new runtime/context per event (≈2 ms/event warm); wall-clock
  overruns kill the worker. Host admission (duplicate → command → audience → rolling
  per-viewer window → automation and shared channel budgets) runs before guest code.
  Admission state is injectable so live versions of one automation share counters.
  `verifyCandidate` runs manifest → restricted syntax/least-privilege analysis →
  compile → generated scenarios (≥3 with happy, edge and negative coverage) → host
  policy suite derived only from the manifest. Reports are bounded to 4 KB for repair.
- **Compiler** (`packages/compiler`): strict JSON Schema output (candidate | question |
  unsupported), exact workspace files, prompt with fenced creator text, deterministic
  intent checks (match/mismatch/assumed/preserved/changed), one repair round, 180 s
  timeout, queue (1 per channel, 4 global, 3 waiting). Transport is injected. Stateful
  edits can emit a separate optional `migrationSource` artifact; strict model output
  requires the nullable field while legacy outputs may omit it. Offline additional
  resources increment the old allowance. Authoring independently checks generated
  migrations against empty, populated, exhausted, paused and finished snapshots
  before storing exact source and check results with immutable candidate evidence.
- **Server**: Codex transport (temp workspace + temp `CODEX_HOME` with only the login,
  read-only sandbox, no network, no web search, minimal env), authoring service,
  private replay (`POST /api/versions/:id/preview`), approval bound to artifact hash and
  expected live version, pause/resume/rollback, panic/resume (in-memory first, persisted,
  survives restart), quarantine on incident, overlay broker (live decisions only,
  heartbeat, rotatable key), Twitch OAuth + sealed tokens + EventSub chat → live runtime.
  Mutating routes require same-origin and `x-riff-request: 1`.
- **Web**: five-step console, private rehearsal stage with personas and proof sequence,
  approval card, authority diff and consent, live library, activity, OBS dock, and a
  read-only overlay that validates messages and clears on heartbeat loss.

Deliberate deviations from the plan above, recorded here so they stay honest:
generated tests are declarative scenarios (data run by the engine) rather than
TypeScript test files; there is no esbuild/tsc stage because handlers are a single JS
expression checked by the TypeScript parser; the compiler's filesystem boundary is
Codex's read-only sandbox in a temp directory, not a separate OS isolate.

Rolling-window admission is durable: every command decision is written to
`admission_events` before any effect leaves the host, and live counters (duplicate
identities, per-viewer windows, per-interaction and channel effect budgets) are rebuilt
from the last hour of records on start. Durable identity also catches redeliveries
older than the engine's 10-minute in-memory window. A failed write sends nothing and
pauses the interaction. Stateful sessions also record cosmetic decisions in
`admission_events`, atomically with gameplay and outbox writes. Per-interaction effect
windows persist across migrations, preserving rollbacks and restarts, independently
of semantic resources and session identities. Stateful engines retain only cosmetic
effect history across replacement; transient input caches remain private so fenced,
uncommitted events can be redelivered after pause/panic. Failed writes rebuild counters from
durable history before explicit resume. `founder` badges count as subscribers: the set id is recorded
from Helix (`packages/twitch/fixtures/helix.get-global-chat-badges.json`) and Twitch
states the badge displays only for current subscribers.

## Stateful experiences — F31

SDK 0.4.0 adds a canonical bounded `ExperienceDefinition` and the read-only `session`
capability. SDK 0.3.0 projectile artifacts keep their bridge and artifact identity.
The host owns teams, participant admission, lifetime round resources, points, phase
and deadlines. Generated handlers read deeply frozen snapshots; no mutable guest
state API is enabled. Both competitive highest-score rounds and cooperative collective
goals use the same engine and independent host verification. Generated scenario data
can assert state; strict model output supports phase/time assertions, while host and
offline fixtures also assert scores and resource subsets.

The server's scoped session repository atomically commits state, an immutable event
identity and an outbox entry. Event identities stay protected across rounds/resets,
versions and restart. Host ingress and ticks serialize per channel; revision/session/
active-version fences prevent stale commits. Outbox intent is claimed before cosmetic
dispatch; state remains accepted if postcommit presentation fails. No external
exactly-once delivery guarantee is made. Preview has separate clocks/state and never
uses the durable live repository or outbox.

Host deadlines survive restart and count downtime; expired rounds finish on recovery.
Pause freezes remaining time. Panic first fences memory, then persists the channel
flag independently of session pause writes. Explicit resume uses persisted panicAt
to recover a pause if an individual session write failed. Canonical definition
changes require a reviewed preserving transition or explicit reset consent; identical-definition
edits preserve progress. Generalized multi-round tournaments remain future work.

Every committed round change (start, chat decision, pause, resume, deadline/recovery
advance) appends a `session_journal` row with a digest of the resulting state in the
same transaction; the repository classifies control writes itself so no call site can
skip the journal. `replaySessionJournal` (sandbox) rebuilds a round in isolated
preview engines and names the first entry that does not reproduce;
`POST /api/automations/:id/session/audit` exposes it read-only (one at a time, works
while stopped). Timer ticks commit only the deadline: clients derive the countdown
from `deadlineAt`, so time alone is never written, journaled or broadcast.

New route: `POST /api/automations/:id/session/reset` requires `{confirm:true}` and the
existing same-origin mutation guard. Approve and rollback accept optional explicit
`resetSession` consent. Studio automation snapshots include `session`; overlay
protocol adds `sessions` with validated canonical definition and snapshot. Rotation
clears old clients but preserves authoritative projection cache for reconnection.
The shared HUD uses safe DOM text, respects reduced motion and clears on lost liveness.
No new environment variables or dependencies were added.


F32 adds tenant-scoped `session_transitions`: immutable migration source, host-computed
plan and evidence identities, source session/version/revision, and durable review,
pending, applied or cancelled status. `channel_state.transition_epoch` fences panic
across asynchronous work and recovery. Panic cancels reviewed/pending transitions;
explicit resume also invalidates them if a secondary cancellation write failed.
Manual activation/reset/discard cancels incompatible reviews. Migration activation
shares the chat/tick queue, revalidates current progress, prepares the target worker,
and commits state/version/status/journal/outbox fencing in one revision-checked
transaction. Stopped transitions require an already-paused session and stay paused;
round-end transitions survive restart and apply to the finished state once.

`POST /api/versions/:id/transition/preview` accepts an optional bounded `migrationSource`
(resolved from immutable candidate evidence when omitted, or a host-provided preserving
fallback for legacy versions),
`boundary` (`immediate`, `round-end`, `stopped`), optional `seed` and up to 24
hypothetical `events`. Its private comparison uses both real host engines with the
same inputs/seed and synthetic provenance; it never dispatches live effects.
`POST /api/transitions/:id/approve` binds `evidenceId`, `artifactId`,
`expectedActiveVersionId`, `sessionId` and `boundary`; `/cancel` permanently cancels
reviewed/pending work. Both use the existing mutation guard. Earlier approved
versions use the same preview/approval path for preserving rollback; incompatible
reductions require explicit full reset. Studio automation snapshots expose scoped
`transitions`. Journals record original definitions plus migration source/version,
plan and resulting digest; audit uses the same session/event seeds as live play.

The console reviews preserved/changed/reset fields, before/after rules, scores and
resources, exact migration source and private synthetic decision comparisons. Changing
version, session, source or boundary invalidates local proof; acceptance of new chat
does not. Existing wider-authority consent and verification blockers gate transition
approval. Live controls expose pending round-end cancellation and review previously
approved healthy rollback targets from current progress, with an explicit full-reset
fallback when preservation cannot pass. Panic blocks approvals; stopped timing requires
an already-paused session and remains paused.

## Audience co-creation — F33

Channel-scoped proposal records persist normalized duplicate groups, private
contributor provenance, revision-checked moderation/history, explicit moderator
grants, attribution preferences, admitted command receipts, ballots/votes and
immutable reviewed selections. Trusted normalized EventSub chat handles reserved
`!riff suggest`, `vote <ballot-id> <option>`, `shortlist <proposal-id>`,
`hide <proposal-id>` and `credit on|off` commands before generated automations.
Unknown reserved commands are consumed; emergency panic keeps independent priority.
Moderator badges require a separate Riff grant; broadcaster moderation is allowed.
No chat command compiles or activates code.

Creator-console routes use the existing operator-local same-origin mutation guard:
`GET /api/proposals`, `GET /api/proposals/:id/history`,
`POST /api/proposals/:id/moderate`, `POST /api/proposals/grants`,
`POST /api/proposals/ballots`, `POST /api/proposals/ballots/:id/close`,
`POST /api/proposals/:id/select`, `POST /api/proposals/selections/:id/revoke`,
and `POST /api/proposals/selections/:id/generate`. Selection saves a reviewed brief
and optional base version; generation is a separate action. A durable selection/run
claim prevents repeat model spending after duplicate requests or restart. Interrupted
work becomes terminal failed rather than silently retrying.

Selection lineage follows every version ancestor and is rechecked before compilation,
inside candidate storage, ordinary activation and F32 transition CAS. Hide, revoke and
reselection abort unused generation and invalidate pending reviews/transitions. Existing
active play continues until explicitly controlled. Channel resume leaves removed-lineage
automations paused while recovering healthy ones, allowing clean approved rollback.

`GET /api/studio` includes private `proposals` and safe public `community` projections.
The overlay protocol adds a nullable `community` frame containing command guidance,
moderated ballots/results and selection application status. It contains no private
brief, account identity, grants or pending/hidden text. Attribution defaults off and
current preferences govern past public results too. Hide/credit changes withdraw cached
content; failed projection reads clear it. Panic fences publication until explicit
resume. The creator inbox hands candidates to the existing rehearsal/approval flow.
Chat ballots require explicit ballot IDs, first valid votes are immutable, deadlines
are enforced transactionally and outcomes never auto-select or auto-compile.

Host limits: suggestion text 8–500; three admitted attempts/account and twenty/channel
per rolling minute; 100 nonhidden proposals; 1,000 contributors/proposal; five options,
one open ballot, 15–600 seconds and 10,000 votes/ballot; 100 grants. Receipts retain
seven days with a 10,000/channel capacity and fail-closed admission. Private response
pages cap at 50; public outcomes/selections at five and attributed names at five.
No SDK changes, dependencies, new Twitch scopes or outbound chat API were added.

## Interactive rehearsal — F34

Host-only versioned rehearsal scenarios fix seed, logical origin, optional initial
session, ordered chat/control steps and explicit expectations. Fresh prefix replay
reconstructs admission windows, dedupe and random effects as well as gameplay state.
A cursor counts applied steps. Compact timeline frames plus one cursor snapshot
carry deterministic scenario/evidence hashes. Automatic quarantine and consistency
checks are distinct from ordinary quota rejections and creator expectation failures.
The SDK guest contract is unchanged; rehearsal accepts no live engine or destination.

Channel-scoped scenario records use revision CAS; runs and saved regressions retain
immutable exact artifact/input/check evidence. The private `/api/rehearsals` routes
use the existing local-operator guard, strict bounded bodies and no-store responses.
They resolve executable artifacts from owned versions, never from client source.
Limits are 120 steps, 20 expectations, 128 KiB/scenario, 256 KiB/replay result,
50 scenarios, 100 retained runs and 50 regressions/channel, and 10 applicable
regressions/automation. Expensive operations have one slot/channel and a 60-second
deadline; cancellation and shutdown stop private workers.

Recording import reads a bounded complete single-version journal with a valid start.
It anonymizes viewer/event identities consistently, preserves roles and duplicate
relationships, substitutes a private channel and replaces unrelated chat with a fixed
marker. Raw names, account IDs, unrelated chat and credentials never enter imported
scenario/compiler content. Migration-spanning and oversized journals are unsupported.
Only the host grants recorded provenance; edits become synthetic derivatives.
Sanitized cosmetics are not claimed to reproduce the live recording byte for byte.
The UI imports directly into a saved capture before editing. New saves of adopted
run inputs carry an owned `sourceRunId`; the host preserves unchanged provenance or
derives it from that run's exact scenario hash. Name-only changes preserve provenance.

Comparisons use identical inputs and seed; initial snapshots must validate against
both versions or the creator explicitly chooses fresh start. This is not F32 migration
evidence. Failure reduction pins the selected failed check and expected/actual values,
counts baseline and final validation within 24 replays/2,400 steps, and reports budget
exhaustion. Unchanged results retain valid original provenance; changed derivatives
must fit the same byte cap. No global minimality guarantee is made.

Saving a regression does not generate code. Explicit repair uses reviewed intent and
bounded quoted evidence through the existing authoring pipeline. Future descendant
compiles pin applicable regressions before generation and independently replay those
inputs; failed checks set the existing verification blocker. Candidate evidence names
the exact checked set. Generated tests cannot weaken saved expectations, and F33
ancestry plus the single automatic repair limit remain in force. Prior approvals are
not retroactively revoked. No rehearsal action automatically activates a version.
Compiler context is separate from creator intent and capped at 96 KiB after JSON
serialization. Scenario samples may be partial or omitted to fit; their labels say so.
The independent host always checks the complete pinned scenarios.

The console preserves quick proof and adds scenario editing, private timeline controls,
state/check inspection, synchronized comparison and separate reduction/save/repair
actions. Aborts and request epochs prevent stale responses from supplying evidence for
another version. Only a complete nonempty passing primary replay marks its exact
artifact previewed. Repair candidates return to the existing evidence/review flow.


## Intent-aware visual canvas — F35

Host-owned SceneDocument v1 binds normalized rectangles, protected regions, trusted
nodes/assets and timing tracks to an exact immutable behavior version/artifact.
SDK scene types grant no guest capability. Compiler and browser validate strict
bounded schemas; compatibility tests keep their defaults and rejection rules aligned.
Required protected camera/captions and readable persistent score/instruction nodes
cannot be removed. All nodes stay inside unprotected regions; critical text cannot
be overlapped. Coordinates are integers in 0–1000, maximum 12 regions/8 nodes,
60-second delays/durations and 100 immutable revisions per behavior version.

Migration 0010 adds channel-scoped scene heads and revisions. Private guarded routes:
`GET /api/scenes/:versionId`, `POST /api/scenes/:versionId`, and POST suffixes
`/generate`, `/undo`, `/apply`. All mutations use revision CAS; apply also echoes the
exact scene digest, checks active healthy behavior, proposal lineage, panic and
collisions with another live interaction's protected area (shared text space is resolved
on stream, and responses carry `sharing` notes). Undo writes a new revision. History is validated and
rehash-checked before use. Direct and language edits share this same storage path.
Geometry-only updates inside an approved region are configuration revisions; region,
asset, node or timing changes require review. Applying either is explicit. Approved
parent presentation is copied immutably to new authored behavior versions; this carries
only presentation approval and never activates the new behavior.

Scene generation uses the existing shared compiler queue, isolated server transport,
strict scene output schema, one repair and 180-second deadline. Selected IDs and
current scene are quoted context, not authority. Host scene compiles use TASK.md only,
not the guest SDK workspace. History records origin, prompt/thread/usage, quoted intent
and selection. Offline mode accepts explicit directional moves and round-end schedules;
unsupported behavior changes go through ordinary Describe/test/review.

Overlay frames add `scenes`; production effect/session frames carry automation and
version identities. Preview and live call the same browser renderer. Projectiles,
labels and splats are clipped inside safe rectangles. Panels hug their text inside the
reserved box; empty panels draw nothing. Across interactions, text is planned first:
shared instructions merge into one panel, a conflicting scoreboard moves to free space
in its own area (or is withheld), and effects get even-odd clip-path holes over other
interactions' text and protected areas. The community card takes a compact free box
near a screen edge, never over protected areas or visible text. Panic, pause/reset, rotation,
disconnect and watchdog clear presentation; subsequent authoritative frames rehydrate.
Small previews page instructions and scores at readable size; no text is executed.
Canvas supports pointer/keyboard/numeric editing, timing tracks, region properties,
private stream/mobile views, reduced motion, diff/digest review and durable undo.
F34 uses its real logical state and timeline; the editor sample is labeled illustrative.

## Shared experiences — F36

`services/collaboration` implements a single authoritative shared coordinator plus a
receiving member service per independently operated instance. Migration 0011 adds
owner-channel-scoped collaboration_sessions and collaboration_receipts, and a local
collaboration_connections row containing AES-GCM sealed connection credentials.
Only this dedicated repository/service exposes allowlisted public projections.
The operator-local home-channel model remains: channels join over scoped bearer HTTP,
not by a caller-controlled channel header or shared private repository access.

Contracts pin verified teamless cooperative behavior, generated tests and 2–4 unique
roles/channels/commands/field grants to SHA-256. Every creator independently verifies
and explicitly approves the digest, then the owner starts with revision CAS. Shared
role commands map explicitly to the pinned contribution command; audience roles stay
local. One running coordinator session, 20 retained sessions, 10,000 receipts/session,
128 pending coordinator inputs and 32 local inputs bound storage/work. State and receipt
commit together before publication. Generated cosmetic effects stay in the separate
shared isolate; only aggregates and approved instructions reach recipient brokers.
No new SDK capability is granted.

Private guarded API: GET `/api/collaboration`; POST suffixes `/create`, `/invite`,
`/review-owner`, `/review`, `/recheck`, `/approve`, `/control`, `/leave`.
Peer POST `/peer/collaboration/{review,approve,heartbeat,input,leave}` requires a scoped
bearer and rejects browser-origin requests. It has no creator authority. Invitations
expire in 15 minutes; tokens are hashed at the coordinator, sealed at the member,
never included in status or overlay projections. HTTP transport accepts explicit
HTTPS origins (HTTP loopback for development), refuses redirects and URL credentials,
and enforces a 4-second request deadline plus 512-KiB streamed response cap (2 KiB
for error bodies). Peer refusals carry the coordinator's fixed host message; members show
it only when it is short and single-line. Shared-command chat is queued, never awaited,
so the channel's serialized chat pipeline does not wait on the network.

Two-second member polling renews 10-second leases. Required loss freezes at lease expiry;
optional departure follows the approved continuation policy. Coordinator restart pauses;
local restart requires verification/approval. Local panic/leave fences before DB/network,
and uncertain remote approvals are revoked best effort. Stale in-flight responses and
inputs cannot rehydrate output. A failed state write requires explicit resume. Host
health/proposal lineage remain checked; execution incidents quarantine the shared round.
Existing local command conflicts reject membership; later conflicts stop it.

Twitch normalization preserves source_message_id/source_broadcaster_user_id with local
fallback identity. Echoes cannot trigger local privileged commands or shared gameplay;
source_badges never become local authority. Verified against the EventSub reference
on November 1, 2026. The browser validates the collaboration projection, displays only
granted aggregate fields and exact role guidance, and uses the canvas safe area ahead
of the community card. Panic, disconnection, watchdog and invalid payloads clear it.
Local frames add partner role labels from the approved contract only. The console panel
is a compact card with a status pill, a readiness row, a host checklist (approve your
role, invite with one-line `riff-invite:` codes, start with stated blockers), a plain
invitation review and a live round card. The stream card leads with the command, a goal
meter and a locally interpolated countdown.
Tests use real isolated engines, separate databases and Fastify injection; this is not
a claim of a live two-creator Twitch demonstration.

## Adaptive director — F37

`services/director` owns deterministic presentation adaptation after durable gameplay
admission. The channel-scoped `director_state` table persists exact draft/approval
identities, synthetic rehearsal evidence, creator controls and the 50 most recent
envelope revisions (the approved revision is never pruned). No queued cosmetics persist or replay after restart. Approval survives,
but presentation stays stopped until an explicit control action resumes it.

Private routes: GET `/api/director`; POST `/api/director/draft`, `/rehearse`,
`/approve`, `/control`, `/stop`. The existing mutation guard and optional console
authentication apply. Draft save does not change live authority. Approval binds the
exact normalized envelope digest and passing rehearsal evidence. Controls select
balanced/gameplay mode, lock or in-envelope manual settings; stop fences memory
before persistence. History restores as a new draft requiring fresh review.

Approved bounds: 250–2000 ms batch interval, 1–6 effects/batch, 25–100% intensity,
1–60 interruptions per rolling minute, FIFO or first-participation visual priority.
The host selects calm settings at >=8 queued cosmetics or >=12 accepted actions
in 10 seconds, or in creator-selected gameplay mode. Pending cosmetics cap at 120,
expire after 5 seconds, and are counted as presented, coalesced, expired or cleared.
Identity memory caps at 2000 with oldest-first eviction; decision history caps at 50
and merges repeated batch/expiry entries so mode changes stay visible. Late emissions recheck
current version, round, live status and panic. Activation and round reset invalidate
pending presentation before selecting another batch. Durable batch claims enforce
the rolling interruption cap across reapproval and restart. Scene protection/reduced motion still
apply. No game-rule cooldowns, resource changes or eligibility edits are accepted;
those require behavior review/F32. The separate gameplay queue caps at 128 pending
chat messages; overflow is visibly rejected before admission or scoring.

Rehearsal runs the chosen immutable artifact twice with an identical synthetic
crowd burst and compares full evidence/state. The director sees those decisions at a
150 ms synthetic chat cadence so the replay shows calm/regular transitions. The same director policy processes
private results; it has no live sink. The console card is collapsed
by default with a status pill and an always-visible stop while adapting; it guides
ranges (quiet chat vs burst) → private stress test → exact approval, then live controls.
Evidence shows final scores, contributions, accepted/blocked counts, coalescing, a
batch-by-batch replay and bounded decision reasons.
This adds no dependencies, Twitch scopes, outbound chat or generated capabilities.


## Contextual remix and distribution — F38

`services/recipes` owns immutable licensed JSON editions and the channel-scoped
`recipe_state` table (migration 0013). Public `/recipes` and `/directory/recipes`
expose only published snapshots and precomputed synthetic demo evidence. Private
`/api/recipes` export/import/remove/profile/adapt/install/publish/moderate/restore operations
remain behind the existing mutation and hosted-console guards. There is no arbitrary
URL import, external artwork execution or anonymous compilation.

Export allowlists public fields, sanitizes tests and preserves declared license and
parent credits. Imported editions pin canonical digests. Revisioned recipient profiles
adapt channel identity, safe layout, en/fr/es/de instructions, reduced motion,
capabilities, command and audience. The shared compiler/verifier/rehearsal pipeline
produces exact diff and evidence; installation rechecks profile and command conflicts,
including host/shared commands, and creates a candidate plus scene draft. Existing
local behavior approval and canvas apply retain activation authority. Source updates
are opt-in. Generated adaptations must match the saved profile's command, audience and
limits or the review fails. Full libraries return 409 with a removal hint (`/remove`
frees imports/exports; installed sources are kept for lineage); report rate keys are
HMAC'd with `RIFF_SECRET` and IPv6 grouped by /64. Publisher identity/rights remain declarations; built-in artwork retains
its project license. Reports can withhold an edition; only a separate explicit rights
review can restore it after all reports are resolved. See the
[recipe service contract](apps/server/src/services/recipes/README.md) for bounds,
routes, trust limits and verification details. No generated capability or SDK version
change is introduced.

## Production setup and inclusive participation — F39/F40

Migration 0014 adds channel-scoped `production_state` and `participation_state` JSON rows.
`services/production` owns authenticated OBS v5 (msgpack under Node) and Streamer.bot
connections (passwords are used once and never stored), sealed source snapshots, exact selected-source setup reviews and approved event/action
mappings. Private `/api/production` routes retain mutation/session guards. OBS setup
first displays the credential-free `/production-test` diagnostic; explicit visual
confirmation enables the scoped live overlay. Rollback checks unchanged settings and
only removes a newly created scene item. Reconnect fences apply/confirm (new connection
identity) but keeps an applied setup's sealed snapshot, so rollback and re-review still
work. Reviewing or importing mappings only stages a draft; approval replaces live
mappings and consumes the review; `/mappings/discard` drops it. Native external
scripts/configuration migration is unsupported; strict `riff-production` imports stage
an inspectable mapping diff. No adapter access is granted to generated code or previews.
Panic fences authority before cleanup; durable causal receipts, bounded queues and
finished-round claims prevent replay/loops. See the production service README for limits.

`services/participation` composes reviewed en/fr/es/de rule templates with current
approved manifests/sessions and recipe presentation. Private `/api/participation`
settings use revision CAS; public `/participation` (1 s cache, per-client token bucket, unknown query keys ignored)
and `/participate` expose only rules, commands, eligible roles, goal progress,
phase, objectives and aggregates. Per-device explicit choices are separate from shared
broadcast settings. `!riff help [language]` highlights protected on-stream guidance for 15 s (`help` flag on
the scene projection; an explicit channel language is never overridden by viewers),
limited to one/viewer/30 seconds and six/channel/60 seconds, with durable deduplication;
it sends no Twitch chat and changes no gameplay permissions. Motion/contrast/text labels
survive edits and recipe sharing/adaptation. Optional recipe metadata preserves old digests.
The dock reuses exact artifact evidence and the existing approval API. Protocol/unit/DOM
checks do not claim live OBS/Streamer.bot rendering or accessibility certification.
