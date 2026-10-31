# Browser applications

Separate console, dock, and transparent overlay entrypoints with shared studio presentation.

See the root README for commands and docs/tech-stack.md for the complete architecture.

Stateful experience HUDs share a safe-text renderer between the console and overlay.
The overlay validates versioned `sessions` messages, resynchronizes from the server,
and clears scores, instructions and effects on stop, disconnect, key rotation or a
five-second heartbeat timeout. It has no interactive controls or console imports.
Tomato Battle and Community Goal are authoring examples; the UI labels the offline
template compiler when no live model is used. Preview output remains private.
