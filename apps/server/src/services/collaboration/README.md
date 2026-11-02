# Shared experiences — F36

`coordinator.ts` owns one authoritative shared QuickJS session and channel-scoped
SQLite state/receipts. `contract.ts` pins the complete artifact, generated tests,
roles, commands and public-field grants to one digest. `member.ts` owns this
instance's independent verification, local approval, encrypted credentials and
synchronous output fence. `transport.ts` bounds authenticated peer requests.

Contracts support verified teamless cooperative rounds: version 1 collective goals and
version 2 collective-goal or burst objectives with burst and milestones. Each role has its
own command, label, field grants, contribution total and `action`: `contribute` (default),
`burst` or `unlock:<milestone>`, each mapped to that definition's own command, so roles
have distinct mechanics without new authority. Validation rejects actions the definition
lacks and requires a role that can reach the objective. Best-of-N `match` (intermissions
reset the shared pool) and `health` (needs opposing teams) are excluded. This does not add
new guest capabilities, arbitrary distributed state mutation or remote cosmetic calls.
Generated cosmetic effects run inside the coordinator isolate but are not broadcast;
only approved aggregate state reaches each receiving channel's own overlay broker.

- Every channel approves the exact digest; the owner then explicitly starts.
- 2–4 unique channel roles; one running coordinator session; 20 retained sessions.
- Invitations last 15 minutes; approved membership lasts until revocation. Tokens
  are bearer credentials: share them only with the intended creator. Coordinator
  stores hashes; receiving instances store only AES-GCM sealed connection material.
- Members poll every 2 seconds; required leases expire after 10 seconds. Loss pauses
  at the lease deadline. Required rejoin needs a new invitation after leave and
  explicit owner resume. Optional-member loss follows the approved continue policy.
- Required loss gives the owner an explicit choice (`/control` `wait` | `continue` | `end`).
  Wait lasts 2 minutes and auto-resumes only when every gating role is back; expiry is
  reported. Continue re-checks that the remaining actions reach the objective and revokes
  the missing memberships. End finishes with final results, even while locally stopped.
  Every choice is an `audit:` receipt listed as `decisions`.
- Raid handoff (opt-in `raidHandoff`, approved in the digest): a member receiving an
  incoming raid from another agreement channel reports it via peer `handoff`. The
  coordinator accepts only a raid from its own channel id, marks that member presenter
  (`presenter` in every projection) and stops the host role gating play. The coordinator
  itself does not migrate; duplicate raid ids are idempotent and no token moves.
- Shared Chat source identities deduplicate echoed/retried messages. Only original
  channel inputs use that channel's authenticated badges. Viewer identities are
  channel-namespaced; raw participant state and credentials never enter projections.
- Inputs have a 128-item coordinator queue and 32-item local queue; receipt history
  caps at 10,000 without eviction. Full history pauses and requires a new session.
- State and receipt commit atomically before aggregate publication. No automatic
  event retry occurs after uncertain HTTP results. Restart pauses rather than
  maintaining a divergent local round. Local panic/leave fences before peer/DB I/O.
- `member.input` claims a matching chat message and queues the coordinator call; it never
  makes the channel's serialized chat pipeline wait for the network (`settled()` awaits the
  queue for tests and shutdown).
- Waiting sessions report who is still missing; finished sessions say whether the goal was
  reached or time ran out. Peer refusals carry the coordinator's fixed host message, which
  the member shows only if it is short, single-line and at most 2 KiB on the wire. Both
  success and error bodies are read through one size-capped reader.
- The local overlay/console frame adds `partners` (other role labels) from the approved
  local contract, never from the coordinator.
- Review is inert and independently runs host verification plus a labeled private
  sample replay. Existing local command conflicts block approval. Later conflicts
  stop local membership. Failure, disconnect and invalid projections withdraw data.

Private local APIs live at `/api/collaboration`: GET status; POST `/create`, `/invite`,
`/review-owner`, `/review`, `/recheck`, `/approve`, `/control`, `/leave`.
Same-origin request guards apply. Peer POST routes live at `/peer/collaboration/`
`review|approve|heartbeat|input|leave` and require a scoped bearer header. They cannot
call creator operations. No token appears in a query string, status response, or overlay.

Each creator runs their own Riff server and authorizes Twitch independently. Configure
RIFF_SECRET and an HTTPS RIFF_PUBLIC_URL reachable by the participating instances.
Expose `/peer` through the same reverse proxy, keeping operator routes local as required
by the existing deployment model. Local development permits explicit HTTP loopback
origins; Vite proxies `/peer`. Redirects, URL credentials and oversized responses fail.
No cloud coordinator, inbound viewer endpoint, additional Twitch scopes or outbound
Twitch chat mutations are introduced.

Shared Chat source identity follows the [Twitch EventSub reference](https://dev.twitch.tv/docs/eventsub/eventsub-reference/#channel-chat-message-event), checked November 1, 2026.
