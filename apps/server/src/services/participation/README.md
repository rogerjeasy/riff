# Inclusive participation — F40

`participation_state` stores revisioned broadcast language/motion/contrast/effect-label
preferences and bounded help receipts per channel. Settings are presentation only;
approved commands, eligibility, limits and scoring stay under the existing host engine.
The existing director's optional first-participation or opportunity-rotation policy
prioritizes cosmetics; accepted gameplay contributions are never dropped by that
presentation policy. While an approved rotation policy is enabled, each interaction's rules
and the on-stream guidance end with the reviewed `fairnessCopy` line ("Priority to viewers
who haven’t had a turn yet", en/fr/es/de).

GET `/api/participation` and POST `/api/participation/settings` use the existing private
session and mutation guards. Saves require `expectedRevision`; a 400 names the invalid
field (for example `settings.language`). The public text companion at `/participate` reads
only GET `/participation?language=en|fr|es|de`. Unknown query keys (cache-busters) are
ignored; a bad or repeated `language` is a 400 that names the parameter. Each client
(`reportClient`, IPv6 /64-aggregated) gets a token bucket of 30 requests refilled at 3/s;
excess requests get 429 with `Retry-After: 1`. The view is cached for 1 s per language and
recomputed early when settings revision, panic state, automation status/version/update
time or session revision/phase changes. It exposes current
approved healthy interactions, declared public rules, aggregate scores, phase and outcome.
Each interaction also carries machine-readable `command`, `joinCommands`, `audience`
(engine roles) and `goal` (`{target, current}` points for collective goals, else null).
It excludes source, prompts, viewer identities, tokens, candidate versions and raw state.
Panic hides participation; disconnected clients clear stale instructions.

The companion has explicit, locally persisted language/contrast/motion choices. Broadcast
preferences apply to everyone watching the same video; individual preferences apply to
the companion. Host-reviewed English, French, Spanish and German sentence templates (`copy.ts`, whole
sentences per language with their own plurals, articles and typography) explain the actual
command, audience ("Only subscribers and moderators"), rolling allowance ("3 per viewer in
any 60 seconds"), team join line before the contribution line, round resource, a
participant cap below the platform maximum of 256 ("Up to 20 players") and the objective:
"Goal: 50 points together", "Highest team score wins" only with teams, and a shared-score
objective for teamless rounds (the engine scores them as one community total).
Version 2 definitions add reviewed `MECHANICS_COPY` phrases (placeholders such as `{label}`,
`{command}`, plural `one`/`other` forms): the burst rule ("5 different viewers typing !shield
within 10 seconds trigger Shield"), shield/points/limit, team health, heal and elimination,
unlocks ("Unlocks !boost at 20 points"), milestones and best-of-N. They are packed as whole
phrases into at most five rule lines; the on-stream phase line adds "Round 2 of 3" and the
objective ("Last team standing wins", "Trigger Shield 3 times to win"). Elimination is its own
outcome ("Last team standing"), never a generic finished round. The scene projection carries
the selected `language`, so the overlay scoreboard and celebration use the web's matching
reviewed copy (`apps/web/src/sessions/mechanics-copy.ts`, which also translates HUD meter
labels and viewer rejection reasons).
Creator-authored titles and team labels remain their original text. Restricted audiences
are described truthfully; settings never expand authority or imply a paid audience is free.

Authenticated local chat `!riff help [en|fr|es|de]` shows current translated rules in the
existing protected scene for 15 seconds. Every accepted help, plain or not, sets the optional
`help: true` flag on each scene projection for 15 seconds so the renderer visibly emphasizes
the guidance for late arrivals; the flag is absent otherwise. A plain help request preserves
each recipe’s reviewed language (or the broadcast override); only an explicit language
temporarily changes it, and only while the broadcast language is `inherit` — an operator’s
explicit language is never overridden by a viewer (help still highlights in that language).
Plain help clears a previous temporary language choice rather than extending it. Recipe
guidance is prefixed with the installed profile’s `displayName`, carried structurally. No outbound chat message or new Twitch scope is
used. Shared-chat echoes cannot trigger it. Limits are one accepted help per viewer in
30 seconds, six per channel in 60 seconds, with ten-minute event deduplication. Hashed
identities and bounded receipts survive restart. Panic clears temporary presentation and
blocks admission; failed help leaves gameplay running. The privileged panic command keeps
its existing role checks.

Persistent broadcast preferences survive behavior changes and rollback. Recipe exports
capture those preferences; recipients explicitly adopt source preferences, save their
profile and use the existing verify/rehearse/diff/install pipeline. Optional contrast and
label keys are written only when true, so re-exporting a pre-F40 edition keeps its digest. Published samples and installed scenes
honor the selected motion, contrast and text labels. No new generated capability is added.

Automated evidence covers actual rule projections, HTTP/auth separation, quotas/replay,
channel isolation, persisted settings, sharing/adaptation, device choices and rendering.
The browser test covers narrow-screen layout and axe accessibility when socket binding
is available. These tests do not certify assistive-technology or real-stream usability.
