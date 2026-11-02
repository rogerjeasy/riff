# Public capability contract

Dependency-free SDK types, capability identifiers and shared policy ceilings. SDK 0.4.0
adds canonical experience definitions and session snapshots; existing 0.3.0 projectile
artifacts keep their rolling allowance behavior. See [SDK.md](SDK.md), generated from
`SDK_GUIDE`, for the compiler-facing rules, bridge types and scenario assertions.

Host consumers also share `director.ts` presentation envelopes, settings and evidence
types. These are host-only contracts; generated automations gain no capability or
new bridge API, and the guest SDK version remains unchanged.

`recipes.ts` adds host-only portable package, profile, synthetic proof and exact review
contracts for F38. These types do not grant guest capabilities or publication authority.

F39 production and F40 participation exports are host/UI contracts only: connector
reviews, named mappings, public guidance and presentation settings. They add no guest
capabilities. Recipe presentation/profile metadata optionally carries high contrast and
effect labels alongside language/reduced motion; omitted fields preserve legacy editions.

F18 adds the guest capability `timer` to SDK 0.4.0 (`TIMER_LIMITS`, `TimerEvent`,
`TimerOp`, scenario `timers` assertions). The policy constants are kept outside
`HOST_LIMITS` so existing artifact identities do not change.
