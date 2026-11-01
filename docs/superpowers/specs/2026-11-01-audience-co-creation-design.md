# F33 — Audience co-creation

Implementation requested directly on main, continuing the existing F32 engine.

## Outcome

Suggest → moderate → shortlist → vote → creator selects → edit brief → generate →
rehearse → approve. Viewers propose “Change to !splat and add two throws”; the
creator selects it and uses F32 to preserve the current round. Neither proposals,
moderators nor vote results can compile or activate code on their own.

## Decisions and trust

The existing server is an operator-local creator console. Its guarded HTTP routes
remain creator authority; do not invent remote user authentication. Chat actors come
only from the existing authenticated normalized EventSub ingress. A Twitch moderator
also needs an explicit creator-managed Riff grant to hide/shortlist. Broadcaster chat
may moderate, but compilation and selection remain console actions. Never accept
role/account identity from HTTP body fields for a chat actor.

Use ordinary chat ballots now, with no new Twitch scopes, outbound chat API, or native
poll integration. Parse reserved commands in a trusted service before automations:
`!riff suggest <text>`, `!riff vote <ballot-id> <option>`, `!riff shortlist <proposal-id>`,
`!riff hide <proposal-id>`, and `!riff credit on|off`. Keep emergency panic precedence.
Consume unknown/malformed reserved commands without passing them to generated code.
Display commands and public ballot/outcome state on the existing read-only overlay.

Attribution defaults off. The author's authenticated credit preference controls
whether the public projection names them. Tell viewers chat submissions are already
public on Twitch; opting out removes Riff attribution, not the original chat message.
Unmoderated/hidden text, raw IDs, private contributor lists, grants and raw chat stay
off public projections, activity messages and overlays. Render all text safely.

## Durable lifecycle and bounds

All tables and queries are channel-scoped. Persist proposals, contributor provenance,
moderation history, grants/preferences, command dedupe/admission, ballots/votes and
selection lineage. Use generated Drizzle migrations, never edit old migration SQL.

Proposal states: pending, shortlisted, hidden, selected; ballot and compile/activation
outcomes are related records rather than ambiguous proposal status overloads. Normalize
duplicate text by trimmed/collapsed whitespace and case; group matches while retaining
each unique contributing account and event provenance. A hidden match must not revive
itself or acquire public visibility. Creator can restore only through explicit review.

Limits: text 8–500 characters; 3 suggestions/account/rolling60s; 20/channel/rolling60s;
100 nonhidden proposals; 5 ballot options; 1 open ballot/channel; 15–600 seconds per
ballot; 10,000 votes/ballot; 100 moderation grants. Bound history response pages to50,
public outcomes to5 and public option count to5. Cap command receipts at10,000/channel
and retain for7 days; fail closed at capacity, prune expired receipts. Rejected/duplicate
suggestions still consume account/channel attempt limits where applicable. Bound
contributor rows per proposal to1000 and apply per-account grouping uniqueness.

Vote identity is account+ballot; first valid vote wins, repeat votes cannot add or move
a vote. Require the explicit ballot ID so delayed chat cannot affect a later ballot.
Voting closes at the exact deadline independent of timer scheduling, survives restart,
and cannot be reopened. Ties are shown; no automatic winner selection or compilation.
Hide removes an option from the eligible/public choices and invalidates selection;
counts/history remain private audit evidence. Stale moderation/ballot/selection actions
use expected revisions or immutable IDs and reject conflicts atomically.

## Selection, authoring and activation

Creator explicitly selects a shortlisted, visible proposal, with optional target base
version, and reviews a bounded editable brief. Selection creates immutable provenance
and a revision-bound authorization. Generation is a separate creator click, limited to
one run per selection (repeat requests return the original result or conflict without
spending quota again). A new deliberate generation requires a new selection.

The selected brief is data passed through the existing compiler, not instructions to
override its policy. Retain selection/run/version links durably and propagate ancestry
when editing a proposal-derived candidate. Removal invalidates unused/stale selection,
queued/in-flight generation and candidate approval, including F32 pending activation.
Check lineage before generation, before storing its result and inside every activation
transaction (ordinary activation, rollback, transition CAS). Never activate a removed
proposal from an old browser card, even after restart. Existing active play is not
silently stopped by moderation; future activation remains blocked. No automatic
generation on submit, vote, close or moderation.

## Studio and audience experience

Add an audience inbox with pending/shortlisted/hidden views, provenance counts,
hide/shortlist/restore, grant management, ballot creation/countdown/results, selection
and editable authoring brief. Explain quota rejection, stale actions, generation
failure, selection and applied outcomes. Existing generation progress and F32 evidence
remain the review/activation route. Creator may select any eligible option regardless
of vote rank; votes are advisory.

Publish a strictly bounded safe projection: command instructions, moderated ballot
options and tally, closed outcome, creator selection and application status. Hide
withdraws text/attribution immediately; preference revocation withdraws credit. No
unmoderated proposal leaks through reconnect cache, history or an error. Panic clears
overlay content and no community update may repopulate it while stopped. Reconnect
and overlay-key rotation preserve only currently authorized projection.

## Acceptance

- Authenticated viewers can submit, be grouped and vote once; limits and identities
  survive restart, and another account has an independent allowance.
- Moderator badge without Riff grant cannot moderate. Revocation takes effect on the
  next command. Viewer text cannot impersonate roles or trigger generation.
- Selected reviewed brief generates a candidate, private rehearsal verifies it and
  creator approval alone activates; the Tomato Battle edit keeps scores and adds two.
- Duplicate generation requests spend once. Hidden/unselected/stale proposals cannot
  compile or activate, including hide during compilation or pending F32 activation.
- Expired ballots reject votes; duplicate/out-of-order events do not corrupt results.
- Public projections omit unmoderated/hidden text and nonconsenting attribution.
- UI is keyboard accessible, responsive, and clearly separates moderation, selection,
  generation and activation. DOM/API tests plus browser verification where permitted.

No new dependencies, general remote moderator portal, automatic execution of winning
proposals, native Twitch polls or outbound chat messages in this increment.
