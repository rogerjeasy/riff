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
The current host exposes only health and static UI; compilation and live integrations
are unavailable, and no untrusted guest evaluator is exported.

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
| Sandbox | `quickjs-emscripten` | WASM isolate: no fs/net, memory + CPU limits, no native build |
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
pnpm test             trusted host/runtime installation tests only
pnpm test:tooling      workspace graph and source-boundary tests
pnpm test:e2e          Chromium/axe checks; requires local sockets
pnpm lint             ESLint plus architecture boundary enforcement
pnpm typecheck        strict source checks in all six workspaces
pnpm check:bundles    inspect production entries after build
pnpm smoke            Fastify injection and SQLite foundation smoke test
pnpm db:migrate       apply committed Drizzle migrations
pnpm db:generate      generate migrations after a schema change
pnpm check            lint, types, host/tooling tests and focused secret scan
pnpm run doctor       tool and dependency inventory (explicit run avoids pnpm built-in)
```

`RIFF_COMPILER_MODE=mock` is the only accepted foundation compiler setting; even
mock fixture compilation is not implemented yet. Live compiler tests, fixture
recording, generated-code lint rules, seeded demos, and event-to-effect smoke tests
are future scripts, not placeholder successful commands.

`.env.example` is the current configuration inventory. Environment parsing in
`apps/server/src/env.ts` validates loopback binding, explicit container binding
consent, ports, log levels, database paths and inactive compiler mode.
Defaults need no external credentials. Future integration fields stay blank.
The only current database table is `channels`; migrate it explicitly with the CLI.

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
