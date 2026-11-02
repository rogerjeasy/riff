# Voice entry — F09

Push-to-talk authoring: the creator records a short description, reviews and edits the
transcript, then chooses to use it. Nothing is generated until they press Generate.

## Routes

- `GET /api/voice` → `{ voice: { provider: 'openai' | 'mock' | 'none', maxDurationMs, maxBytes, mimeTypes } }`.
- `POST /api/voice/transcribe` — raw `audio/webm|mp4|mpeg|wav` body (no multipart
  dependency), route-scoped 2 MiB body limit, `x-riff-audio-duration-ms` header
  (≤ 60 s + rounding), the global same-origin + `x-riff-request: 1` mutation guard and the
  optional console session gate. Returns `{ transcript: { text, provider, durationMs } }`.
- Errors carry a typed `code` and a user-safe `message`: `NOT_CONFIGURED` 503,
  `UNSUPPORTED_TYPE` 415, `TOO_LARGE` 413, `TOO_LONG`/`EMPTY`/`INVALID` 400, `BUSY` and
  `RATE_LIMITED` 429, `NO_SPEECH` 422, `PROVIDER_REJECTED`/`FAILED` 502, `TIMEOUT` 504.

## Bounds

One transcription in flight per server, six per rolling minute, 30-second provider
deadline, never retried automatically (retry is an explicit creator action). Transcripts
are stripped of control/bidi/zero-width characters, whitespace-collapsed and capped at
1,200 characters (the composer limit).

## Data handling

Audio exists only in the request's memory and is handed to the transport; it is never
written to disk, the database or logs. Logs record only the error code and a safe detail
(provider HTTP status), never the transcript, audio or key. `apiKey`/`api_key` are also in
the Pino redaction list.

## Providers

Configured by `RIFF_TRANSCRIPTION_MODE` (`off` | `mock` | `openai`; empty means `openai`
when `OPENAI_API_KEY` is set, else `off`) and `RIFF_TRANSCRIPTION_MODEL` (default
`gpt-transcribe`).

- `openai`: `POST https://api.openai.com/v1/audio/transcriptions`, multipart `file` and
  `model`, response `{ text, languages }`, 25 MB provider limit, supported containers
  include webm/mp4/mpeg/wav — verified against
  <https://developers.openai.com/api/docs/guides/speech-to-text> on November 1, 2026.
  Uses native `fetch`/`FormData` instead of the `openai` SDK to avoid a dependency.
  The transport was exercised only against a fake `fetch`, not a live key.
- `mock`: deterministic phrase chosen from a SHA-256 of the audio bytes, for tests/e2e.
- No provider: the console falls back to the browser's Web Speech API where available
  (disclosed as possibly processed by the browser vendor), otherwise shows
  "Voice unavailable — type instead".
