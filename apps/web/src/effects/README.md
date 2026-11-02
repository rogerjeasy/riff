# Trusted effects

Owned renderer primitives with bounded assets and animation budgets. Generated code cannot
provide HTML, CSS, or renderer JavaScript: it picks one of the owned assets (`tomato`, `star`,
`heart`) and a launch position, and the host draws everything else.

`projectile.ts` (`launch`, `assetMarkup`, `clearStage`) is shared by the live overlay and every
private preview:

- **Flight** — a quadratic Bézier arc sampled into Web Animations keyframes and eased as one
  flight, with a slight stretch on the way up and a spinning sprite.
- **Trail** — six fading puffs (`[data-projectile-trail]`) dropped along the path, each timed
  to the moment the eased flight passes it.
- **Impact** — squash on contact, the owned splat, a shock ring and nine particles shaped per
  asset (juice drops, sparkles, mini hearts; CSS clip-path polygons, see `public/CREDITS.md`).
- **Budget** — at most `maxActive` (12) live projectiles; extras are dropped, never queued. Only
  the projectile itself carries `[data-projectile]`, so counts and budgets ignore its pieces.
  Every piece removes itself when its animation ends and `clearStage` removes all of them.
- **Performance** — transform and opacity only (no filters or layout properties animate).
- **Reduced motion** — the projectile appears at its target without flight, trail or burst.
