# OBS adapter

`client.ts` uses the installed `obs-websocket-js` 5.x client against authenticated OBS
WebSocket v5/RPC1. Under Node the library uses the `obswebsocket.msgpack` subprotocol.
Its `connect()` result omits the Hello `authentication` field, so the adapter observes
the library's `Hello` event to require authentication; a server without it is
disconnected and refused. A rejected password (close code 4009) is reported plainly.
Its closed interface supports scene discovery, exclusive Riff browser-source
inspection/setup and scene-item rollback. It rejects shared scene/group references
before updating a global input. Creator-facing refusals are thrown as `ToolRefusal`;
scene lists are returned unbounded for the service to filter. No generic request
surface reaches guest code. The host [production service](../../services/production/README.md)
owns grants, exact reviews, sealed settings, deadlines and panic fencing. Tests cover a
library-faithful mock and a real in-process v5 server (Hello → Identify with
`base64(sha256(base64(sha256(password + salt)) + challenge))` → Identified →
GetSceneList); actual OBS rendering must be verified separately.
