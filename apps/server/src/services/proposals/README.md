# Audience co-creation

`createProposalService(connection, channelId, { now })` owns inert audience proposals,
moderation, ballots, creator selection, attribution, and bounded admission. Every
mutation runs in a synchronous SQLite transaction; the clock is injectable.

Console routes construct `{ kind: 'creator' }` only after the existing local-console
guard. Trusted normalized chat ingress supplies `{ kind: 'chat', accountId,
displayName, roles }`; HTTP body fields must never construct chat authority.
Broadcaster chat can moderate; moderators need both the moderator role and a
creator-managed Riff grant. Selection and grant management remain console actions.

`parseProposalCommand` identifies the reserved namespace; `handleCommand` consumes
unknown and malformed reserved commands and persists admission receipts. Panic is
reported separately so the host's independent emergency path keeps precedence.
A duplicate event returns its first durable decision, regardless of changed body.

`publicProjection()` returns only eligible moderated ballot/selection text and
consented sanitized names. Strings are plain text: render through React text nodes
or `textContent`. No raw account identifiers, receipts, contributor lists, grants,
pending/hidden text, reviewed briefs, or moderation history belong in public output.
The overlay broker owns panic suppression, caches, and key rotation.

Selection records contain immutable `brief`, `baseVersionId`, proposal identity and
revision, plus an irreversible `revokedAt` marker. `assertSelectionAuthorized(id)`
must run before generation, before storing its result, and within activation
transactions. Selecting again makes the earlier revision stale; hiding irrevocably
revokes every selection, including after restore. Existing active play is untouched.
Generation, run/version ancestry and activation enforcement are owned by authoring
and runtime services, not this module. There are no model calls or external effects.
