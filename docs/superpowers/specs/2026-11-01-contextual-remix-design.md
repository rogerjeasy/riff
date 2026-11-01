# F38 Contextual remix and distribution

## Intent and approach

Creators publish a sanitized immutable recipe; a second channel previews, adapts,
inspects differences, rehearses and installs a local candidate before normal local
approval. This extends F26–F29 using the existing compiler, verifier, scene canvas
and sandbox. No trust or approval is inherited from a publisher.

The implementation uses a self-hosted public directory on each Riff instance and
portable JSON files. No central cloud dependency or arbitrary URL fetching is
introduced. Public pages replay precomputed synthetic demonstrations; receiving
channels run actual isolated verification and rehearsal. Public attribution is a
publisher declaration, not a cryptographic identity assertion.

## Public recipe contract

A strict bounded versioned JSON package contains recipe ID, monotonically increasing
publication revision, SHA-256 digest of canonical content, title, public description,
author, license, exact source/manifest/tests, scene, public presentation preferences,
parent source and author/license lineage. Only MIT, CC0-1.0 and CC-BY-4.0 declarations
are supported; derivatives preserve the source license and all credits. Publisher
must explicitly attest distribution rights. Only built-in tomato/star/heart asset
references are supported, with Riff credit and receiving-installation project-license
rights; no external asset URLs, files, markup or embedded asset bytes are accepted.
Recipes do not relicense the renderer's built-in artwork.

Export builds fields explicitly. It never serializes private prompts, stored live
state, participant records, credentials, approval/evidence records or directory
reports. Test identities are synthetic. Secret-like values in public metadata/code
are rejected before export/publication. Imported metadata and source remain
untrusted; digests establish integrity, not authorship or permission.

Public source editions are immutable and individually pinned; publication updates
create another revision, never mutate installed recipes. Publication is an explicit
owner action separate from export. Reports are bounded, deduplicated and rate-limited;
only the local operator can withhold a listing or resolve a licensing/abuse report.
Withholding removes public discovery/download, but never secretly changes existing
local gameplay. Public endpoints expose only published recipe snapshots and synthetic
samples, never channel repositories. Hosted console sign-in exempts only exact public
recipe route patterns. Private mutations retain existing same-origin/auth guards.

## Receiving channel workflow

1. Import bounded JSON, validate integrity/license/assets and retain the pinned source.
   Unknown capabilities or SDKs produce a visible unsupported result, not substitution.
2. A revisioned local profile records display name, explicit language (en/fr/es/de),
   reduced motion, chosen safe scene, supported capability subset and proposed command,
   audience, rolling allowance/window. Existing supported capabilities are overlay and
   session; only user:read:chat is required, never an unsolicited extra Twitch scope.
3. “Make this fit my channel” uses the existing compiler transport with public source
   context and explicit profile intent. It validates generated source/tests and runs
   synthetic proof/crowd scenarios in private engines. A source inspection without rule
   changes may use the exact artifact and still runs local verification. Unknown or
   excluded capabilities remain blocked. Proposed differences include source, manifest,
   capabilities, command conflicts, scene, identity, language and motion. Any model
   output outside supported assets/contracts fails verification.
4. Review evidence is bound to exact source digest, candidate artifact, scene/profile
   and profile revision. Install rechecks profile, source, current command conflicts,
   evidence and digest, idempotently creates a local candidate and saves its scene.
   It does not approve or activate. The console opens existing version review and
   points to its canvas approval. Updates optionally target an installed local version,
   preserving the same automation and ordinary F32 transition review where needed.
5. Lineage follows local descendants for export/review; source updates require explicit
   new import/adaptation. Translation is reviewed host instruction copy derived from
   the exact manifest (not arbitrary translated game rules). Reduced motion is carried
   into the existing scene renderer, while its protected regions remain enforced.

## Bounds and persistence

One expensive operation per channel, shared existing compiler queue, abort on shutdown,
180-second deadline. Packages <=128 KiB, source <=16 KiB, tests use existing bounds,
lineage <=8, profile revisions use CAS, <=50 imported packages, <=50 reviews,
<=50 published editions, <=100 reports. Every private table is scoped by channel.
Public listing search is capped at 20 results; report text <=500, bounded hash-only
IP rate keys (no raw IP exports). Duplicate install returns the exact existing candidate.
No new runtime dependencies, Twitch scopes, arbitrary network reads or automatic updates.

## Acceptance and failure cases

Two isolated channels can export/import, adapt a command/audience/window, inspect
source and capability differences, rehearse, install and activate locally with retained
lineage. Source edits never alter pinned local candidates. Test unknown capability,
command collisions introduced during async work, stale profile, modified evidence,
unauthorized assets, secret/privacy exclusion, duplicate install, public/private route
authorization, report/moderation lifecycle, safe scene and reduced motion. Test real
compiler mock fixtures and real sandbox engines; browser execution limitations are
reported honestly. Preserve all pending F37 work and leave this increment uncommitted.
