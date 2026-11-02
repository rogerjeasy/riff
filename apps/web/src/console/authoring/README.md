# Intent authoring

Text/voice input, transcript review, generation progress, questions, and bounded repair feedback.

- `composer.tsx` — the Describe card: free text (always available), examples, generation
  progress, questions and failures.
- `voice.tsx` — F09 push-to-talk. Hold the button (pointer, Space or Enter) to record, or
  tap/activate once to start and again to stop; Esc discards. Shows a level meter, elapsed
  time against the 60-second cap, and explicit permission-denied, no-device, unsupported,
  not-configured, transcribing and failed-with-retry states. Audio uploads to
  `POST /api/voice/transcribe`; without a server provider the browser's Web Speech API is
  used where available. The transcript lands in an editable review field and is only
  placed into the description when the creator chooses; it never starts a generation.
