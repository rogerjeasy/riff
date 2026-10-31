# Platform authentication

Implemented in `../auth.ts`. It covers the authorization code grant, token exchange, refresh and `/validate`. The host still owns encryption at rest, the startup and hourly validation schedule, and pausing the channel on a failed refresh.
