# Activity and incidents

Bounded causal history, allowed/blocked effects, recovery instructions, and aggregate insights.

The F16 feed is `ActivityFeed` in `../live/live-panel.tsx`. It renders the server projection
(`apps/server/src/services/automations/activity-view.ts`): source, interaction version
(selectable for review), outcome with a plain-language reason and allowed/blocked effect
counts, with an All / Blocked / Incidents filter. Aggregate insights live in `../insights`.
