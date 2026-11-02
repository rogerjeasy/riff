# In-chat authoring (F10) and owner chat approval (F17)

`service.ts` lets the broadcaster build and approve interactions from their own Twitch
chat. It is **off by default**; the creator turns it on in the console after an explicit
risk confirmation (`POST /api/chat-authoring/settings`, revision CAS).

## Authority

- Only the channel owner is accepted: the EventSub `broadcaster` badge **and**
  `chatter_user_id === broadcaster_user_id`, from a local (non-Shared-Chat) message.
  Display names, message text and moderator/subscriber badges never grant authority.
- Non-owner attempts are consumed, never answered in chat, never charged to any budget
  and logged to activity (`CHAT_AUTHOR_DENIED`, at most six per minute).
- `!riff panic` keeps precedence; while stopped, chat is ignored entirely.

## Commands

| Command                         | Effect                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `!riff create <intent>`         | Queue a compile through the shared compiler queue and verifier                                                |
| `!riff edit <intent>`           | Same, based on the active version of the single live interaction                                              |
| `!riff approve <code>`          | Activate exactly the bound candidate via `studio.approve`                                                     |
| `!approve`                      | Alias, consumed only when exactly one owner code is active; otherwise passes through to generated automations |
| `!riff reject <code>`           | Spend the code and discard that candidate                                                                     |
| `!riff status` / `!riff cancel` | Report or stop the pending chat build / withdraw its code                                                     |

Intent is untrusted data: C0/DEL/C1, zero-width and bidi controls are stripped,
whitespace collapsed, 8–500 code points. It is passed as `intent` to the same
`authoring.start` the console uses, so the compiler fences it as creator text.

## Approval codes

- Issued only when the candidate passes verification **and** would be approvable from the
  console without extra consent: no approval blockers, intact proposal lineage, no
  wider-authority change and no change to a live round's rules. Otherwise the candidate
  stays in console review and chat is told why.
- 5 characters from `ACDEFGHJKMNPQRTUVWXY34679` (no 0/O, 1/I/L, 2/Z, 5/S, 8/B), `crypto.randomInt`.
  Valid 5 minutes on the host clock. One active code per channel.
- Bound to `versionId`, `artifactId` and the `expectedActiveVersionId` at issue time.
  Approval rechecks all three, then calls the console's exact-approval path.
- Single use: the code is durably consumed **before** activation is attempted; a refusal
  marks it `failed` with the reason. Reuse, expiry, withdrawal, invalidation and stale
  binding are rejected with a reason in chat and in activity.
- Five wrong codes in 10 minutes pause chat approval for the rest of that window.
- Panic, turning the feature off, and console revoke invalidate codes immediately
  (memory first, persistence best effort) and cancel a pending chat compile.

## Restart semantics

State lives in the channel-scoped `chat_authoring_state` row. Codes **survive restart
until expiry** and are re-validated against the exact candidate when used. A persisted
panic invalidates them on boot. An in-flight chat compile cannot survive restart (the
compiler run is in-process), so boot clears it and records an activity entry. The chat
compile budget (3 per rolling 15 minutes) and wrong-guess counters are persisted.

## Chat replies

Replies are host-owned system messages sent with Helix Send Chat Message as the
broadcaster (`user:write:chat`, requested at sign-in only when this feature is on). They
start with `Riff · ` so the EventSub echo can never parse as a command or slash command,
are capped at 500 characters, attempted once (never retried) and budgeted to 10 per
minute host-side. Without the scope the console shows a reconnect link; everything else
still works and the console is notified live. Generated code has no path to this sender.
