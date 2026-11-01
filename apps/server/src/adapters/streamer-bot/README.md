# Streamer.bot adapter

`client.ts` implements authenticated Hello/challenge/Authenticate for the documented
WebSocket API (authentication requires 0.2.5+), then subscribes only to Custom.Event.
Only GetActions and named DoAction are exposed. Action lists are returned unbounded
(within the frame cap) for the service to filter; creator-facing failures are
`ToolRefusal`s. Requests correlate by UUID, cap at
16 pending, time out after four seconds and are never retried. Frames cap at 64 KiB;
redirects are disabled. The [production service](../../services/production/README.md)
owns exact mappings, durable deduplication, causal loop limits and authority checks.
Native exports/scripts are explicitly unsupported by the bounded mapping importer.
Protocol tests use an in-process mock and a real in-process WebSocket server
(Hello/Authenticate/Subscribe/GetActions/DoAction and Custom.Event delivery), not a
live Streamer.bot instance.
