# Capability bridge

`guest-worker.ts` installs the JSON-only `overlay` and `session` capabilities.
Every handler gets a fresh QuickJS context. Overlay emits require a declared capability
and bounded validated projectile payloads. `riff.session.snapshot()` requires declared
`session` authority and a canonical staged snapshot. The returned object and all nested
data are deeply frozen; enrollment, resources, scoring and round clocks remain host-owned.
No persistent guest globals, arbitrary mutable store, filesystem or network are exposed.
`riff.predictions.propose()` requires declared `predictions` authority, accepts one
strictly validated proposal per event and only returns it in the decision; opening and
settlement are creator actions in the host console.
