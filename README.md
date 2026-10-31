# Riff

Invent your next live experience together.

Riff turns a creator's sentence into a **working, controlled Twitch interaction**:

> “Let viewers throw tomatoes with !tomato, limited to three throws per person in any rolling 60 seconds.”

**Describe → Test → Preview → Approve → Play.** Codex compiles the sentence at runtime
into a handler, a permission manifest and declarative tests. The host independently
verifies them in the same QuickJS sandbox that runs live events, shows the evidence in
plain language, rehearses it privately, and activates only the exact artifact the
creator approved. Real Twitch chat (EventSub) then drives it on an OBS overlay, with
pause, rollback and an emergency stop always one click away.

## Try it in two minutes

```sh
./scripts/pnpm dev            # server :8787 + console :5173 (migrations run at boot)
```

Open <http://localhost:5173>:

1. **Describe** — press **Generate** on the prefilled Tomato Toss sentence.
2. **Test** — read the approval card (when · what · who · how much · what passed), the
   _what you asked vs. what will run_ table, the pipeline stages, every generated and
   host-owned scenario, and the exact code and manifest.
3. **Preview** — press **Run proof sequence** on the private stage: three throws land,
   the fourth is blocked with a reason, Bob is unaffected, a redelivered message is
   ignored, chat noise is ignored, and the allowance returns after the window.
4. **Approve** — approval binds to the artifact hash and the live version you saw.
5. **Play** — copy the overlay URL into an OBS browser source (1920×1080), connect
   Twitch, and let chat type `!tomato`. Then press **Edit**, generate
   _“Change the command to !splat, allow two throws per 30 seconds, subscribers only”_,
   review the authority diff, approve, and roll back.

By default the server uses the deterministic **offline template compiler** (no model
call, honestly labelled in the UI). To compile with **Codex at runtime**, sign in to the
Codex CLI once (`codex login`) and set `RIFF_COMPILER_MODE=codex` in `.env`.

Measured on this machine with Codex CLI 0.166.0 (`./scripts/pnpm compile:live … --edit …`):
Tomato Toss compiled, verified and matched the intent in 39 s on the first attempt;
the `!splat` / 30 s / subscribers-only edit in 63 s, also first attempt, with every
stage and intent check passing.

## How it is built

```text
apps/web        Console (5-step studio), private rehearsal stage, OBS dock, read-only overlay
apps/server     Fastify host: authoring queue, verification, approval, live runtime,
                overlay broker, Twitch OAuth + EventSub, SQLite (Drizzle)
packages/sdk    Dependency-free contract: events, manifest, effects, decision codes,
                declarative scenarios, SDK guide and curated examples given to Codex
packages/compiler  Codex output contract (strict JSON Schema), prompt workspace, intent
                checks, offline compiler, compile orchestration (1 repair), queue
packages/sandbox   QuickJS engine (warm worker, fresh runtime per event), admission,
                static analysis, scenario runner, host policy suite, verification pipeline
packages/twitch    EventSub WebSocket lifecycle, Helix, OAuth, chat normalization, fixtures
```

**Trust model in one paragraph.** Codex never receives credentials, repository files or
network tools: each compile runs in a fresh temp workspace holding only `TASK.md`,
`SDK.md`, two `.d.ts` files and curated examples, a fresh `CODEX_HOME` with only the
login, a read-only sandbox, and no web search. Its output is a strict JSON object; the
host then runs manifest validation → restricted-syntax analysis → sandbox compile →
the generated scenarios → a host-owned policy suite the compiler cannot edit, plus
deterministic intent checks. Command matching, audience, per-viewer rolling windows,
channel budgets and duplicate suppression are enforced by the host before guest code
runs. Guest code runs in QuickJS with 64 MB memory, 50 ms CPU, 2 s wall time, 25 bridge
calls and no ambient authority; any fault quarantines the version and discards its
effects. Preview engines have no route to the overlay or Twitch; the overlay broker
rejects non-live decisions by construction.

**Live controls.** Approval checks the artifact hash and the expected live version
(stale reviews get 409). Edits and rollbacks keep viewer allowances. `Stop everything`
(console, dock or `!riff panic` from the broadcaster or a moderator) flips an in-memory
fence first, clears the overlay, persists second and stays stopped across restarts
until explicitly resumed.

## Twitch

1. Create an app at <https://dev.twitch.tv/console/apps> with redirect URL
   `http://localhost:8787/auth/twitch/callback`.
2. Set `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` and `RIFF_SECRET`
   (`openssl rand -base64 32`) in `.env`, restart, and press **Connect Twitch**.
   Riff asks only for `user:read:chat`; tokens are sealed with AES-256-GCM at rest.
3. Without a Twitch app you can still exercise the full live path with the
   [Twitch CLI mock EventSub server](https://dev.twitch.tv/docs/cli/websocket-event-command/):
   set `TWITCH_EVENTSUB_WS_URL` / `TWITCH_HELIX_URL` to the mock endpoints. The
   automated test `apps/server/test/twitch-live.test.ts` drives the same path with the
   documented EventSub protocol and fixtures.

## Commands

| Command                        | Purpose                                                             |
| ------------------------------ | ------------------------------------------------------------------- |
| `./scripts/pnpm dev`           | Server watch mode and Vite hot reload                               |
| `./scripts/pnpm check`         | Lint, boundaries, strict types, all unit/integration tests, secrets |
| `./scripts/pnpm test:e2e`      | Chromium end-to-end flow with axe accessibility checks              |
| `./scripts/pnpm compile:live`  | One real Codex compile (+ `--edit "…"`) through the full pipeline   |
| `./scripts/pnpm build`         | Packages, server and the console, dock and overlay entries          |
| `./scripts/pnpm check:bundles` | Proves the overlay bundle contains no console code                  |
| `./scripts/pnpm smoke`         | Fastify + SQLite health smoke test                                  |
| `./scripts/pnpm db:generate`   | Generate a migration after a schema change                          |
| `./scripts/pnpm run doctor`    | Tool and dependency inventory                                       |

After `build`, `./scripts/pnpm start` serves the compiled UI and API on port 8787.

Read [AGENTS.md](AGENTS.md) for the engineering contract, [the SDK guide](packages/sdk/SDK.md)
for the exact contract Codex compiles against, and [setup](docs/setup.md) for installation.
