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
stage and intent check passing. The stateful reference prompt (“Create a tomato battle
lasting two minutes. Viewers join red or blue, each gets three throws…”) compiled to a
red/blue `!throw` battle in 41 s and its edit into a `!grow` community goal of 10 in
43 s, both first attempt with 5/5 stages and 7/7 independent host checks passing.

## Stateful experiences

Choose **Tomato Battle** or **Community Goal** in Describe. Both pass through the
same compiler, independent verification, private rehearsal, exact-version approval
and live Twitch execution as Tomato Toss.

- **Tomato Battle:** join Red with `!red` or Blue with `!blue`, then use `!throw`.
  Each participant has three throws for the entire round. The overlay shows scores,
  participation instructions, time remaining and the winner or tie at 120 seconds.
- **Community Goal:** use `!grow` to contribute hearts. Participants join automatically;
  each has three contributions. The session finishes when the community reaches five
  points or its deadline expires.

The SDK 0.4 definition declares participants, teams, resources, scoring and the
objective. These rules run in the host; generated handlers read a frozen session
snapshot and decide the cosmetic presentation. Gameplay continues even if the
cosmetic effect budget is full. SDK 0.3 Tomato Toss artifacts remain supported.

Session state, processed event identities and effect outbox entries commit together
in SQLite. Concurrent inputs cannot overspend resources; duplicate Twitch events
cannot award points twice, including after restart or reset. Cosmetic effects use
at-most-once dispatch intent; reconnecting overlays receive authoritative state.

A pause freezes remaining time. Deadlines continue through ordinary server downtime;
startup finishes an expired round once. Emergency stop persists independently of
session writes and stays stopped after restart. Explicit resume recovers the frozen
clock from the panic timestamp if a session pause could not be saved.

**Verify round.** Every committed change to a round — start, each chat decision,
pause, resume and the deadline — is journaled in the same transaction with a digest
of the state it produced. Pressing **Verify round** replays the journal in a private
engine and proves the live scoreboard reproduces exactly from its inputs, or names
the first entry that does not. It is read-only and works while the channel is stopped.

Visual-only edits preserve the session when its canonical rules are unchanged.
Compatible rule edits use a reviewed migration; incompatible changes and starting a
new round require explicit full-reset consent. Prior event identities and cosmetic
rate budgets remain protected.

## Live evolution — F32

Edit a running Tomato Battle with:

> Change the command to `!splat`, keep everyone's teams and scores, and give each
> player two additional throws.

The compiler produces the new behavior and a separate migration. Independent host
checks verify it against empty, populated, exhausted, paused and finished snapshots.
When a round is live, review asks one question: **Keep everyone's progress** or
**Start a fresh round**. If the new rules cannot carry progress over (fewer resources,
different points, teams, objective, a shorter round or fewer players), keeping is
disabled and the card says why in plain language. To keep progress, choose when it
takes effect (**right now**, **when this round ends**, or **while paused**) and preview.
The card lists what is kept and what changes, highlights changed rules, shows each
player's progress with deltas (for example `1 → 3 +2` throws), and compares the live
and new versions answering the same hypothetical chat in private engines. A paused
round is resumed on private copies for that comparison, so the old command visibly
stops working and the new one starts. Failed migrations name the reason without
echoing guest output.

Approval binds the exact version, migration and evidence. The host reruns migration
against current progress, including chat accepted during review, before committing
state and version together. A failed or stale transition leaves the old interaction
intact. Migrations run in a bounded, effect-free isolate; generated code cannot waive
preservation checks or refill host abuse counters.

Round-end changes persist across restart and can be cancelled in the live panel.
They apply to the finished round without starting another. Stopped changes require
a paused interaction and leave it paused. Emergency stop cancels pending changes.
Rollback reviews the current state against an earlier approved version; it never
restores an old score snapshot. **Verify round** also replays migrations and uses the
same random seed as live play.

This first implementation preserves existing participants, teams, scores,
contributions, phase and remaining time, and supports resource increases and command
edits. Changes such as removing resources, changing points per contribution, team
identities or the objective require a full reset. Increasing configured round duration
does not extend the current round's remaining time. The offline compiler supports the
reference edit; model output follows the same migration checks. No recurring-round
scheduler or partial-reset mechanism is introduced.

See the [stateful design](docs/superpowers/specs/2026-10-31-stateful-experiences-design.md),
[live evolution design](docs/superpowers/specs/2026-10-31-live-evolution-design.md)
and [SDK guide](packages/sdk/SDK.md) for contracts and supported primitives.

## Audience co-creation — F33

Viewers can propose the next mechanic; the creator decides what becomes code.
The audience inbox connects moderation, chat ballots and an editable selected brief
to the existing generation, private rehearsal and exact-version approval flow.

1. In connected Twitch chat, submit `!riff suggest Change the command to !splat and
give everyone two additional throws`.
2. In **Audience ideas**, the idea appears under **To review** with a short number
   (`#1`). Shortlist it. Matching suggestions form one idea with a "Suggested by N
   viewers" count. Hide unwanted ideas; restoring one sends it back to review.
3. Tick **Add to vote** on up to five shortlisted ideas, pick a voting time
   (30 s–10 min) and **Start vote**. The stream shows a vote card with live bars and one
   short command, `!riff vote 1 <number>`, where `1` is the ballot number. Each account
   gets one vote per ballot; results and ties are advisory and stay on stream for two
   minutes after the vote closes.
4. Choose **Review brief** on any shortlisted idea (or **Use** next to a result). The
   brief opens at the top of the inbox with three steps: review the brief, generate,
   then test, rehearse and approve. When exactly one interaction is live, the brief
   defaults to editing it. Save the selection, then explicitly generate. Repeated
   generation requests return the same run, including after restart.
5. **Review & approve candidate** jumps to Test and Preview. For the Tomato Battle edit,
   use **Keep everyone's progress** to inspect preserved scores and two additional
   throws, then approve the exact evidence through the normal F32 flow. The stream then
   announces "Chat idea #1 · Now live" for 20 minutes.

Twitch moderators need a creator-managed **Riff moderation grant** to use
`!riff shortlist <#>` or `!riff hide <#>` with the idea number from the inbox (`12`
and `#12` both work; full IDs remain accepted). A badge alone is not a
grant. The broadcaster may moderate through chat; selection, generation and approval
remain creator-console actions. Voting, moderation and chat never generate code.

Credit defaults off. `!riff credit on` allows Riff to display the contributor's name;
`!riff credit off` withdraws that attribution from current and historical public
results. Twitch chat itself is already public, and this preference does not remove
the original chat message. Only moderated, currently eligible text reaches the overlay;
private briefs, grants, account IDs and pending/hidden suggestions stay private.

Suggestions are 8–500 characters, with three attempts per account and twenty per
channel in any rolling 60 seconds. Duplicate/rejected admitted attempts count toward
those limits; redelivered transport events do not. The host caps nonhidden proposals
at 100, contributors per proposal at 1,000, votes per ballot at 10,000 and grants at 100.
Vote bursts refresh open consoles at most four times a second. Command receipts are retained for seven days, capped at 10,000 per channel;
admission fails closed at capacity. Ballot deadlines and vote identities survive restart.

Hiding a proposal or replacing its selection cancels unused generation and pending activation.
Every derived version retains its selection ancestry, checked again when storing and
activating it. Removing an idea does not silently stop an already running interaction.
After emergency stop, explicit channel resume leaves removed interactions paused and
recovers healthy ones; a clean approved predecessor remains available for rollback.
The overlay clears on emergency stop and cannot repopulate until explicit resume.
On stream the audience panel sits bottom-right, clear of the round scoreboard
(top-left) and interaction instructions (bottom-left). When nothing is happening it
shrinks to a one-line invitation.

This uses chat ballots and the existing read-only overlay, with no additional Twitch
scopes or outbound chat messages. The creator console retains the existing local
operator trust model. See the [F33 design](docs/superpowers/specs/2026-11-01-audience-co-creation-design.md).

## Interactive rehearsal — F34

Choose the **Scenario studio** tab in the private preview card (**Quick proof** stays
one click away). A scenario fixes its seed, logical origin and inputs. **Play** saves
your inputs, asks the host for one complete private replay, then plays it back step by
step with outcomes on the step list and team scores on the stage. Pause, step, drag
the cursor or click any step: the host replays exactly that prefix in a fresh engine,
including duplicate protection and allowance windows, and the inspector explains the
decision, effects, allowance, scores and every viewer's resources. A verdict sums up
expectations and host safety checks in plain language.

Start from a preset (**Proof**, **Crowd burst**, **Duplicate delivery**, **Late
arrival**, **Run out**, **Deadline**) or the live round, then refine in **Edit
inputs**: synthetic chat with a chosen viewer and roles, duplicate deliveries, and
clock or round controls. **Compare with another version** replays the same inputs and
seed on both, flagging the steps that differ. A fresh-start comparison is rehearsal
evidence; preserving a live round still uses the separate F32 transition review.

To exercise the repair loop with Tomato Toss:

1. Load the **Run out** preset and press **Play**. Click step 4 (Limit reached), choose
   **+ Expect an outcome here**, set the outcome to **Thrown (ACCEPTED)** and **Add
   expectation**.
2. Choose **Run to end**. The verdict reports “Step 4 should give Thrown — it gave
   Limit reached.”
3. **Fix this failure** → **Reduce selected failure**, inspect the retained inputs, then
   **Save regression**.
4. In **Saved regressions**, describe the repair (for example, allowing four throws),
   confirm you reviewed it and **Generate repair candidate**. The existing compiler and
   independent checks run again, including the saved regression; the candidate's
   evidence lists it as passed or failed. Rehearse and approve the exact candidate
   through the normal workflow. Saving or reducing a failure never starts generation
   or activation.

Saved regressions are immutable and survive deletion of their source scenario.
Future descendants of their origin version check a pinned set; a failing check
blocks candidate approval. Existing approved versions retain their previous evidence.
A passing run proves only the inputs and checks shown.

**Import and save current round** pins a capture before editing and uses a saved
scenario slot. Recording imports anonymize identities, preserve roles and duplicate
relationships, and retain only recognized interaction commands. Other chat becomes a
fixed marker. Imports require a complete single-version journal of at most 120 steps;
oversized or migration-spanning recordings are rejected. Sanitized cosmetic randomness
can differ from the original stream, so this is not a byte-identical live audit.

Bounds: 120 steps, 20 expectations, 128 KiB per scenario and 256 KiB per replay result;
50 scenarios, 100 retained runs and 50 regressions per channel, with at most 10
applicable regressions per automation. One expensive operation per channel has a
60-second deadline. Reduction uses at most 24 replays and 2,400 steps, including
baseline and final validation, and reports when its budget stops it. It does not
claim a globally smallest failure. Nothing in rehearsal sends to live destinations.

See the [F34 design](docs/superpowers/specs/2026-11-01-interactive-rehearsal-design.md).

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
login, a read-only sandbox, and no web search. Host-only scene edits use a quoted
`TASK.md` scene contract instead of the guest SDK workspace. Its output is a strict JSON object; the
host then runs manifest validation → restricted-syntax analysis → sandbox compile →
the generated scenarios → a host-owned policy suite the compiler cannot edit, plus
deterministic intent checks. Command matching, audience, per-viewer rolling windows,
channel budgets and duplicate suppression are enforced by the host before guest code
runs. Guest code runs in QuickJS with 64 MB memory, 50 ms CPU, 2 s wall time, 25 bridge
calls and no ambient authority; any fault quarantines the version and discards its
effects. Preview engines have no route to the overlay or Twitch; the overlay broker
rejects non-live decisions by construction.

**Live controls.** Approval checks the artifact hash and the expected live version
(stale reviews get 409). Edits, rollbacks and restarts keep viewer allowances, duplicate
protection and effect budgets (recorded in SQLite before any effect is sent). `Stop everything`
(console, dock or `!riff panic` from the broadcaster or a moderator) flips an in-memory
fence first, clears the overlay, persists second and stays stopped across restarts
until explicitly resumed.

## Visual canvas

**Stream layout · Arrange the overlay** sits under the rehearsal. It opens automatically
once a version is live; for a candidate, press **Edit layout**. Drag an object to move it,
or drag its corner to resize it. Drag an area's ⠿ handle to move the area together with
everything inside it. Arrow keys move the selection 10 units (Shift moves 1), and Alt with
the arrows resizes it. An object dropped wholly inside another open area moves into that
area. Camera and captions are protected. **Phone-size preview** and **Reduced motion** use
the same renderer as the stream.

1. Choose **Scoreboard on the right**, or move the effects area. You can also select
   **Celebration** and choose **After the round ends**. A rule-breaking draft stays
   visible: the object is marked and a message names it, such as “Effects covers the
   protected Camera region”.
2. **Save layout**, then rehearse real chat above. The canvas sample round shows the
   layout only; it is not test evidence.
3. Read **Review and apply**. It lists plain changes from the applied layout, such as
   “Scoreboard moved to 580, 20”, along with the exact document. Activate the behavior
   through the existing workflow, then **Approve and apply layout**. The status changes
   to “This layout is live”.
4. Select Effects and type **Move left by 10 units**. **Draft this change** runs the
   same host checks. A move inside an approved area becomes a small change you can apply
   with **Apply layout change**. Changes to timing, sprites and protection need review again.
5. Restore a previous layout from history to create a new revision. Concurrent edits
   show a conflict; reload before saving again.

On stream, every panel shrinks to fit its text inside its reserved box, and an idle
scoreboard draws nothing. When several interactions are live, their instructions combine
into one panel. A scoreboard moves to the nearest free spot in its own area, and is held
back only if no spot exists. Effects keep playing but are cut away where another
interaction's text or protected area sits. The audience card takes a compact free spot
near a screen edge. The canvas warns when a layout shares space with another live
interaction. Applying is blocked only when one interaction's objects would cover another's
protected area.

The runtime model receives the selected object or area and the current layout. Offline
mode supports explicit directional moves and schedules such as **Show this 2 seconds after
round end for 5 seconds**. It rejects other wording. Behavior and capability changes use
Describe and its existing verification pipeline. New behavior versions keep an immutable
copy of their parent's approved layout without bypassing behavior approval.

Layouts allow only owned sprites and trusted text, bound to exact behavior artifacts.
No canvas preview publishes to Twitch or the live overlay; only explicit application can
change an approved live layout.

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

## Deployment

Pushes to `main` that pass CI deploy automatically to AWS Lightsail. Terraform manages the
infrastructure, AWS Secrets Manager holds the secrets, and GitHub OIDC grants short-lived
AWS access. Streamers are listed in `infra/terraform/prod/terraform.tfvars`. See
[infra/deploy/README.md](infra/deploy/README.md) for the pipeline, one-time setup and
streamer access.

## Commands

| Command                        | Purpose                                                             |
| ------------------------------ | ------------------------------------------------------------------- |
| `./scripts/pnpm dev`           | Server watch mode and Vite hot reload                               |
| `./scripts/pnpm check`         | Lint, boundaries, strict types, all unit/integration tests, secrets |
| `./scripts/pnpm test:ci`       | Fast key test subset that CI runs (full suite stays in `check`)     |
| `./scripts/pnpm test:e2e`      | Chromium end-to-end flow with axe accessibility checks              |
| `./scripts/pnpm compile:live`  | One real Codex compile (+ `--edit "…"`) through the full pipeline   |
| `./scripts/pnpm build`         | Packages, server and the console, dock and overlay entries          |
| `./scripts/pnpm check:bundles` | Proves the overlay bundle contains no console code                  |
| `./scripts/pnpm smoke`         | Fastify + SQLite health smoke test                                  |
| `./scripts/pnpm db:generate`   | Generate a migration after a schema change                          |
| `./scripts/pnpm run doctor`    | Tool and dependency inventory                                       |

CI runs only formatting, lint and boundaries, strict types, `test:ci`, tooling tests and
the secret scan. Run `check` and `test:e2e` locally before merging.

After `build`, `./scripts/pnpm start` serves the compiled UI and API on port 8787.

Read [AGENTS.md](AGENTS.md) for the engineering contract, [the SDK guide](packages/sdk/SDK.md)
for the exact contract Codex compiles against, and [setup](docs/setup.md) for installation.

## Shared experiences across channels — F36

**Shared channels** sits above the workspace as one compact card. Its header pill always
shows where things stand: “Not sharing”, “Waiting for channels”, “Live · 3/5”, “Coordinator
unreachable” and so on. It opens automatically while a round is being set up or played.

Each creator uses their own Riff instance and Twitch connection. Configure `RIFF_SECRET`
and an HTTPS `RIFF_PUBLIC_URL` that the other instances can reach. Keep creator-console
access local and forward `/peer` for collaboration traffic. HTTP loopback origins support
two-instance local development.

1. **Set up.** The readiness row confirms secure storage and Twitch, and shows your channel
   ID with **Copy ID**. Collect your partners' channel IDs the same way. Under **Host a
   round**, pick a verified teamless cooperative version and give each channel a role name,
   a command and the fields its overlay shows. Each role card says exactly what is missing,
   for example “Add this channel’s numeric Twitch ID”.
2. **Create shared agreement.** A three-step checklist follows:
   - **Approve your own role:** **Review my role** re-tests the version and shows the same
     review an invited creator sees.
   - **Invite the other channels:** **Create invitation** gives a one-line `riff-invite:…`
     code, a **Copy invitation** button and a live expiry countdown (15 minutes). A new
     invitation revokes the previous one.
   - **Start the round:** stays disabled with the reason shown, for example “Waiting for
     Steer ship to approve and connect”.
3. **Join.** The invited creator pastes the code under **Join a round** and presses **Review
   invitation privately**. Riff re-tests the exact version on their machine, then shows:
   - their role and command, what each command counts for, the goal and round length
   - who can join, the allowance per viewer, and what their overlay shows
   - what happens if they leave, and every channel in the agreement
   - a private replay, such as “Counted · Counted · Counted · Resources spent”

   Nothing joins until they tick consent and press **Approve my role and view**; **Decline**
   leaves. Coordinator refusals arrive as readable reasons, for example “Coordinator: The
   shared round has finished.”

4. **Play.** Each console shows a live card with the role, partner roles, a goal progress
   bar, time left and the channel's contributions. The stream overlay leads with “Type
   !steer”, a goal meter and a countdown that ticks every second between updates. It ends
   with “Goal reached together” or “Time ran out before the goal”.
5. **Pause, resume or leave.** Pause and resume from the host checklist, or leave from
   either console. A local emergency stop clears output immediately. Losing a required
   member pauses the round; rejoining and resuming are explicit and keep progress. An
   optional member's departure follows the policy shown in the agreement. Losing the
   coordinator never starts an independent round.

Shared-command chat is handed to the coordinator without holding the channel's chat
pipeline, so other interactions keep responding during a slow or unreachable coordinator.

The bounded first shared contract maps role commands to the same verified cooperative
action. It supports one running collaboration per instance, four members, 20 retained
coordinator sessions and 10,000 event receipts per session. Behavior changes require a
new agreement and new consent. Roles from another channel, raw participant snapshots,
private prompts and Twitch credentials never become shared authority or public output.
See [the collaboration contract](apps/server/src/services/collaboration/README.md).

## Voice entry and insights — F09/F30

**Voice.** In Describe, hold **Hold to talk** (or Space/Enter on it), or tap once to start
and again to stop. A level meter and a timer show the 60-second cap. The transcript appears
in an editable review box; choose **Use as description** or **Add to description**, then
press Generate as usual. Typing always works. Set `OPENAI_API_KEY` (and optionally
`RIFF_TRANSCRIPTION_MODEL`) to transcribe on the server, or `RIFF_TRANSCRIPTION_MODE=mock`
for deterministic offline transcripts. Without either, browsers with speech recognition use
it; others show “Voice unavailable — type instead”. Audio is never stored. See
[the voice contract](apps/server/src/services/voice/README.md).

**Insights.** The **Insights** card summarizes the last stream, 24 hours or 7 days: people
taking part, admitted vs blocked actions over time, why actions were blocked, a
per-interaction table, round outcomes, generation success/latency, incidents and proposal
engagement, with suggestions such as “12 actions on Tomato Battle were blocked by the
per-viewer limit — consider raising it…”. It is aggregate only: groups under three people are
hidden and no one is ranked. See [the insights contract](apps/server/src/services/insights/README.md).
