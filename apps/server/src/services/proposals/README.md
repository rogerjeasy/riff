# Audience co-creation

`createProposalService(connection, channelId, { now })` owns inert audience proposals,
moderation, ballots, creator selection, attribution, and bounded admission. Every
mutation runs in a synchronous SQLite transaction; the clock is injectable.

Console routes construct `{ kind: 'creator' }` only after the existing local-console
guard. Trusted normalized chat ingress supplies `{ kind: 'chat', accountId,
displayName, roles }`; HTTP body fields must never construct chat authority.
Broadcaster chat can moderate; moderators need both the moderator role and a
creator-managed Riff grant. Selection and grant management remain console actions.

Proposals and ballots carry short channel-scoped numbers, assigned inside the insert
transaction (migration 0008 backfills older rows). Chat may name either by number
(`!riff vote 3 2`, `!riff hide #12`) or by immutable ID; the explicit ballot number
still fences delayed votes from a later ballot.

`parseProposalCommand` identifies the reserved namespace; `handleCommand` consumes
unknown and malformed reserved commands and persists admission receipts. Panic is
reported separately so the host's independent emergency path keeps precedence.
A duplicate event returns its first durable decision, regardless of changed body.

`publicProjection()` returns only eligible moderated ballot/selection text and
consented sanitized names. Strings are plain text: render through React text nodes
or `textContent`. No raw account identifiers, receipts, contributor lists, grants,
pending/hidden text, reviewed briefs, or moderation history belong in public output.
Credited names come from one bounded join against current credit preferences, and
inbox pages use grouped counts. The projection is rebuilt every second, so it must
never scan contributors per row. The overlay broker owns panic suppression, caches,
and key rotation. Suggestions, votes and credit changes cannot revoke lineage, so the
app coalesces their console refreshes (250 ms). Moderation still reconciles and
publishes immediately.

Selection records contain immutable `brief`, `baseVersionId`, proposal identity and
revision, plus an irreversible `revokedAt` marker. `assertSelectionAuthorized(id)`
must run before generation, before storing its result, and within activation
transactions. Selecting again makes the earlier revision stale; hiding irrevocably
revokes every selection, including after restore. Existing active play is untouched.
Generation, run/version ancestry and activation enforcement are owned by authoring
and runtime services, not this module. There are no model calls or external effects.
