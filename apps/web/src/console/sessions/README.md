# Session controls

The console displays host-owned round snapshots and offers pause/resume and a confirmed
session reset. Approval and rollback require separate reset consent when the canonical
experience definition changes. HTTP requests carry the existing same-origin marker;
this browser never imports server or SDK implementation code.

`session-hud.tsx` wraps the trusted DOM presentation in `src/sessions/presentation.ts`.
The private rehearsal, live library and read-only OBS overlay use that same definition
and presentation. Rehearsal clocks and participants are explicitly synthetic; joins,
contributions, duplicate delivery and deadline advancement all replay through the
server's isolated preview engine. Generated and host scenario results expose session
phase, scores and participant resource evidence.

Collaboration and director controls remain future scope.
