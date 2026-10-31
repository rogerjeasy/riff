# Platform fixtures

Every file is copied from an official Twitch documentation example and carries a
`_source` URL. Example values that look like credentials are replaced with stable
fake values, and those files are marked with `_note`. Hand-invented Twitch payloads
are not allowed. Tests may change ids or the fields under test on a copy.

| File                                                                                                               | Source                                                                         |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `channel.chat.message.json`                                                                                        | channel.chat.message "Regular Chat Message Example" (`subscription` + `event`) |
| `session_welcome.json`, `session_keepalive.json`, `notification.json`, `session_reconnect.json`, `revocation.json` | Handling WebSocket Events examples                                             |
| `helix.create-eventsub-subscription.json`                                                                          | Create EventSub Subscription, Example Response 2 (websocket)                   |
| `helix.get-users.json`                                                                                             | Get Users example response                                                     |
| `oauth.*.json`                                                                                                     | Authorization code grant, refresh and validate examples                        |
