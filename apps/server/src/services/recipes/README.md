# Contextual remix and distribution — F38

The operator hosts a public directory at `/recipes`; its private library lives in the
creator console. Portable JSON lets another independently operated channel import a
pinned edition without arbitrary URL fetching or central infrastructure.

Export selects public source, manifest, sanitized synthetic tests, safe scene geometry,
author/license and immutable lineage. It excludes private intent, participants,
credentials, compilation records and approval. Packages are capped at 128 KiB, source
at 16 KiB and lineage at eight entries. Assets are references to the three built-in
artworks, never external URLs or embedded bytes. The declared recipe license applies
to code and copy; artwork remains under the installation's project license. Authorship
and rights are publisher declarations, not identity certification.

Import validates canonical SHA-256 and shows unsupported SDK/capability blockers.
A revisioned profile supplies identity, en/fr/es/de instructions, reduced motion,
scene geometry, allowed capabilities and requested rules. Adaptation uses the shared
compiler queue, host verifier and isolated synthetic crowd rehearsal. Exact-source
rehearsal bypasses generation only. Diff, evidence, destination and profile are hashed.
Install rechecks current commands/capabilities/profile and creates a candidate with a
scene draft. Existing version approval and canvas apply remain required for play.
Source updates are opt-in, never changes to an installed version. Re-export preserves
parent credit and license. Host `!riff` and active shared role commands stay reserved.

Private API: GET `/api/recipes`; guarded POST suffixes `/export`, `/import`, `/profile`,
`/adapt`, `/install`, `/publish`, `/remove`, `/moderate`, `/restore`. The channel-scoped
`recipe_state` table (migration 0013) is one JSON record. `GET /api/recipes` returns the
stored lists plus `exports` (`{digest, recipeId, revision, title}`, identity `null` for
older rows) and `limits` so the console can show remaining room.

Bounds (`RECIPE_LIMITS` in `contract.ts`): 128 KiB packages, 16 KiB of UTF-8 source,
50 imports, 50 exports, 50 reviews, 50 publications, 100 reports with at most 20 open per
edition, and five reports per client per hour. Capacity is managed, never a permanent lock:

- `/remove` takes `{ kind: 'import' | 'export', digest }` and returns `{ state }`. An import
  that produced an installed version is kept (exports of that version need its license and
  credits); its message says so. Removing an import also drops its uninstalled reviews.
- New reviews prune the oldest failed or superseded (same source and destination) uninstalled
  review. Installed reviews are evidence and stay. The review cap is checked before any
  model or sandbox work.
- New reports prune the oldest resolved report; open reports are never dropped.
- Publication checks its cap and revision order before the rehearsal.

Explicit `recipeId` exports must name a recipe this channel exported or published, and the
revision must be the previous highest revision + 1 (omit it to get that number). An
identical re-export is idempotent. A new recipe starts at revision 1.

Errors carry `{ code, message }` with a specific human message. HTTP status: `INVALID` 400,
`NOT_FOUND` 404, `LIMIT` 409 (make room, e.g. "Remove an older import to make room"),
`RATE` 429 (report rate limit only), `BUSY` 503 (compiler queue full, another recipe job
running, or shutdown), and 409 for `STALE`, `BLOCKED`, `UNSUPPORTED`, `CONFLICT`. Package
validation errors name the first failing field ("title is missing"). Manifests are checked
with the sandbox `manifestSchema`; failures become import blockers such as
"manifest.trigger is missing" rather than crashes.

Expensive work is single-flight per channel and runs in the shared compiler queue. A full
queue maps to "The compiler is busy, try again in a moment". The 180-second deadline and
shutdown abort compile and rehearsal and report "timed out after 180 s" or "stopped because
the server is shutting down"; `verifyCandidate` takes no signal, so its result is discarded
when the deadline passed. Publication refuses to store results after shutdown began.

Generated adaptations are checked against the profile after compilation. For projectiles
the trigger command, audience, `maxPerViewer` and `windowMs` must match; for experiences the
contribution command, audience and per-round resource (the profile allowance) must match.
Any difference makes the review `passed: false` with a check line naming the field, so it
cannot be installed.

Public text is scanned field by field for recognizable credentials: JWTs, GitHub
(`ghp_`/`gho_`/`github_pat_`), AWS `AKIA…`, Slack `xox[abpr]-`, `sk-` keys, PEM private keys,
Twitch `oauth:` tokens, Bearer tokens and URLs with `user:pass@`. Base64 `data:` URIs are
refused as embedded assets. Ordinary words and plain URLs are allowed. The message names
the field ("description looks like it contains a secret token").

Install links (F27): `/recipes/install?from=<origin>&digest=<sha256>` (or `#<digest>`)
opens a guided install in the console. Guarded POST `/api/recipes/install-preview`
`{digest, package?}` is read-only: it takes the edition from this directory's published
snapshot (or a creator-chosen file, which must carry exactly the linked digest), re-verifies
the canonical digest and returns the public package, demo proof, `compatibility` (SDK,
capabilities, Twitch consent with same-origin grant links, Affiliate/Partner eligibility,
command conflicts; `blocked` checks stop install, `consent` does not), an authority `scope`
diff against nothing installed or the installed edition of the same recipe, and `existing`
(`none|imported|installed|other-revision`). POST `/api/recipes/install-link`
`{digest, package?, profileRevision, targetVersionId?}` imports, adapts the exact source,
rehearses and installs a candidate; an import it created is removed again if any step fails.
An edition already installed returns `alreadyInstalled: true`. There is no remote URL fetch:
links naming another directory ask the creator for the downloaded file. Pure checks live in
`install.ts`.

Public API: GET `/directory/recipes?q=...`, GET `/directory/recipes/:digest`, guarded
POST `/directory/recipes/:digest/report`. Only published, non-withheld snapshots are
visible. Publication verifies again and stores actual synthetic sandbox decisions for
playback; anonymous visitors never execute code. Lists return the newest 20 matching
editions. Report rate keys are HMAC-SHA256 under the server secret (`RIFF_SECRET`, injected
as `rateSecret`; a random per-process key when none is configured), over the client IPv4
address or IPv6 /64. At most 100 keys are kept: expired keys go first, then the key seen
least recently. Forwarded client addresses are accepted only through a private/loopback
proxy peer; public deployments must restrict direct access to the app behind their
trusted proxy.

Module layout: `contract.ts` (schemas, digest, limits, readable validation), `secrets.ts`
(credential scan), `proof.ts` (shared rehearsal proof for adapt and publish),
`presentation.ts` (translated stream copy and the adaptation intent), `retention.ts`
(pruning and rate keys), `service.ts` (orchestration).

Withholding hides an edition. Resolving another report cannot restore it. Restoration
requires all reports resolved and a separate operator rights attestation. Imported
local copies remain pinned and require local review; moderation cannot revoke code
already downloaded to another installation.

Tests cover independent databases, real sandbox evidence, exact review installation,
profile/command races, unsupported capabilities, assets, public/auth boundaries,
lineage, moderation and translated/reduced-motion live scene projection, plus capacity
pruning and removal, report caps, HMAC rate keys and IPv6 /64 grouping, profile mismatch
detection with a disobedient transport, recipe-id ownership, queue/deadline/shutdown
messages, canonical undefined handling, byte-bounded source and the credential scan. Browser tests
exercise publication, playback and a remix candidate with the offline compiler. No
live model, Twitch or multi-creator broadcast demonstration is claimed by those tests.
