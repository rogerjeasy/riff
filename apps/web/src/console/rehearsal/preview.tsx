import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

const resultSchema = z.object({
  provenance: z.literal('synthetic'),
  reference: z.literal('Tomato Toss'),
  artifactId: z.string().regex(/^[a-f0-9]{64}$/),
  seed: z.number().int(),
  decisions: z
    .array(
      z.object({
        eventId: z.string(),
        artifactId: z.string(),
        mode: z.literal('preview'),
        code: z.enum([
          'ACCEPTED',
          'UNRELATED',
          'AUDIENCE',
          'VIEWER_LIMIT',
          'CHANNEL_LIMIT',
          'DUPLICATE',
          'INVALID_EVENT',
          'INCIDENT',
          'DISABLED',
          'STOPPED',
        ]),
        reason: z.string().max(200),
        effects: z
          .array(
            z.object({
              kind: z.literal('projectile'),
              asset: z.enum(['tomato', 'star']),
              x: z.number().min(0).max(1),
            }),
          )
          .max(10),
      }),
    )
    .max(64),
});
type PreviewResult = z.infer<typeof resultSchema>;
interface PreviewEvent {
  id: string;
  viewerId: string;
  channelId: string;
  roles: ['viewer'];
  text: string;
  at: number;
}

export function InteractionPreview() {
  const [events, setEvents] = useState<PreviewEvent[]>([]);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [viewer, setViewer] = useState('alice');
  const [command, setCommand] = useState('!tomato');
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function replay(next: PreviewEvent[]) {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setBusy(true);
    setError('');
    setEvents(next);
    try {
      const response = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed: 42, events: next }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Preview unavailable. Try again shortly.');
      const evidence = resultSchema.parse(await response.json());
      if (!controller.signal.aborted) setResult(evidence);
    } catch {
      if (!controller.signal.aborted)
        setError('Preview unavailable. Check the local server, then try again.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function stop() {
    request.current?.abort();
    setBusy(false);
    setStopped(true);
    setResult(null);
  }
  function reset() {
    request.current?.abort();
    setBusy(false);
    setStopped(false);
    setEvents([]);
    setResult(null);
    setAt(0);
    setError('');
  }
  const full = events.length >= 64;
  const effects =
    result?.decisions.flatMap((decision, index) =>
      decision.effects.map((effect, i) => ({ ...effect, key: `${index}-${i}` })),
    ) ?? [];
  return (
    <section className="rehearsal" aria-labelledby="preview-heading">
      <div className="preview-heading">
        <div>
          <p className="eyebrow">Private rehearsal · synthetic chat</p>
          <h2 id="preview-heading">Tomato Toss</h2>
        </div>
        <span className="badge">Reference module · SDK 0.2.0</span>
      </div>
      <p className="description">
        Let viewers throw tomatoes with <code>!tomato</code>, limited to three throws per person in
        any rolling 60 seconds.
      </p>
      <p className="muted">
        This preview uses a reviewed reference module. Runtime generation and live activation come
        next.
      </p>
      <div
        className="preview-stage"
        role="img"
        aria-label={`Private overlay preview: ${effects.length} admitted tomatoes`}
      >
        <div className="stage-caption">
          PRIVATE OVERLAY <span>Simulated effects only</span>
        </div>
        {effects.length === 0 && (
          <p className="stage-empty">Send a chat command to try your interaction.</p>
        )}
        {effects.map((effect) => (
          <span
            key={effect.key}
            data-testid="projectile"
            className="projectile"
            aria-hidden="true"
            style={{ left: `${8 + effect.x * 84}%` }}
          >
            {effect.asset === 'tomato' ? '🍅' : '⭐'}
          </span>
        ))}
      </div>
      <form
        className="preview-controls"
        onSubmit={(event) => {
          event.preventDefault();
          void replay([
            ...events,
            {
              id: `event-${events.length}`,
              viewerId: viewer,
              channelId: 'private-preview',
              roles: ['viewer'],
              text: command,
              at,
            },
          ]);
        }}
      >
        <label>
          Viewer
          <select
            value={viewer}
            onChange={(event) => setViewer(event.target.value)}
            disabled={busy || stopped}
          >
            <option value="alice">Alice</option>
            <option value="bob">Bob</option>
          </select>
        </label>
        <label>
          Chat command
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            maxLength={500}
            disabled={busy || stopped}
          />
        </label>
        <button type="submit" disabled={busy || stopped || full}>
          Send command
        </button>
      </form>
      <div className="preview-actions">
        <button disabled={busy || stopped} onClick={() => setAt((value) => value + 60_000)}>
          Advance 60 seconds
        </button>
        <button
          disabled={busy || stopped || full || !events.length}
          onClick={() => {
            const last = events.at(-1);
            if (last) void replay([...events, { ...last, at }]);
          }}
        >
          Replay last event
        </button>
        <button disabled={stopped} onClick={stop}>
          Stop preview
        </button>
        <button onClick={reset}>Reset preview</button>
      </div>
      <p role="status">
        {busy
          ? 'Running isolated replay…'
          : stopped
            ? 'Preview stopped. Reset to resume.'
            : `Replay clock: ${at / 1000}s · ${effects.length} effects admitted`}
      </p>
      {full && <p>Replay contains 64 events. Reset to start a fresh rehearsal.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="evidence">
        <h3>Execution evidence</h3>
        <p className="muted">
          Each request replays the same seed and ordered events through fresh isolated state.
        </p>
        {result && (
          <p className="artifact">
            Artifact: <code>{result.artifactId}</code> · Seed {result.seed}
          </p>
        )}
        <ol aria-label="Event decisions">
          {result?.decisions.map((decision, index) => (
            <li data-testid="decision" key={index}>
              <span
                className={decision.code === 'ACCEPTED' ? 'decision-accepted' : 'decision-blocked'}
              >
                {decision.code}
              </span>
              <span>
                {events[index]?.viewerId} · {events[index]?.at ?? 0}ms · {decision.reason}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
