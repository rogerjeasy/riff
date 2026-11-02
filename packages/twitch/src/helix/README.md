# Helix adapter

Implemented in `../helix.ts`, the only place that builds Twitch HTTP requests.
`channel-points.ts` and `predictions.ts` shape paths and bodies for those endpoint families
and use the transport passed in by `createHelixClient` (`request.ts`); `limits.ts` holds the
documented request bounds.
