# Community proposals

`inbox.tsx` is the operator-local creator inbox. It consumes the guarded proposal
HTTP routes through `lib/api.ts`; `contracts.ts` mirrors their bounded private
wire shapes without importing server code.

Creators can page/filter grouped suggestions, moderate against exact revisions,
page private history, grant/revoke moderator authority, run advisory chat ballots,
and edit/save immutable reviewed selections. Save and generate are separate
controls. Editing or withdrawing a selection removes generation authority locally;
request epochs ignore superseded pages and late selection/generation responses.
Synchronous locks suppress duplicate clicks. Server checks remain authoritative.

Returned generation runs are handed to the app's existing run store immediately,
including durable replay results. Candidates continue through existing evidence,
private rehearsal and approval/F32 transition review. The inbox has no activation
control. The server's current public community projection supplies applied status.

Public overlay validation lives in `community/schema.ts`, separately from console
state. Its DOM renderer replaces all text and credit on each frame and clears on
null, invalid community replacements, panic, disconnect and heartbeat loss.

Focused tests: `test/proposals.test.tsx`, `test/proposal-api.test.tsx` and
`test/community.test.tsx` under `apps/web`.
