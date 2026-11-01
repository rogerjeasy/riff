# Recipe library (F38 console and public directory)

Creator-facing remix and distribution. The server contract lives in
`apps/server/src/services/recipes/README.md`; this folder only renders it.

| File              | Role                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `library.tsx`     | Collapsed console card with a status pill and three tabs                                 |
| `remix.tsx`       | Bring in a recipe → fit it to your channel → adapt and rehearse → review and install     |
| `share.tsx`       | Describe, license and attest → inspect the sanitized export → download or publish        |
| `published.tsx`   | Your public editions, withhold/restore, and the operator-only report queue               |
| `directory.tsx`   | Public `/recipes` page: search, deep links (`/recipes#<digest>`), demo, download, report |
| `differences.tsx` | Key-level before/after for adapted rules; unchanged fields collapse to one line          |
| `rules.tsx`       | Plain-language rule facts (command, audience, allowance, needs)                          |
| `preview.tsx`     | Synthetic sample chat on the shared `StagePlayer` (never a live overlay)                 |
| `use-recipes.ts`  | Private state, one request at a time, request epochs against stale responses             |
| `contracts.ts`    | Zod schemas mirroring the server responses                                               |

Rules the UI keeps: adaptation and install use only the saved profile and the exact
reviewed digest; a changed profile or destination marks the review stale; installing
creates a candidate that still needs ordinary behavior and canvas approval; tab panels
stay mounted so unsaved edits survive switching tabs. Shared building blocks
(`PanelCard`, `Tabs`, `Step`, `Stat`, `Check`) live in `../panel-kit.tsx`.
