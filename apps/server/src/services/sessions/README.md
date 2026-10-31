# Durable experience sessions

Canonical round control is implemented in `../live/sessions.ts`, serialized ingress
and timers in `../live/runtime.ts`, and atomic state/event/outbox persistence in
`../../db/repositories/sessions.ts`. All records are scoped to the home channel.

Competitive team scores and cooperative goals use the same canonical SDK definition.
The host enforces participant/resources/phase rules and stages cosmetic guest output.
A state transaction precedes at-most-once outbox dispatch. Private rehearsal uses a
fresh isolated engine and never this repository. Source faults and pause freeze time;
ordinary downtime counts toward a running deadline. Panic persists independently of
secondary session writes. Incompatible definitions require explicit reset consent.

Future F32 migrations and broader session primitives remain in the approved roadmap.
