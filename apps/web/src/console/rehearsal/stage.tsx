import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import { clearStage, launch } from '../../effects/projectile.js';
import type { Decision, PreviewResult, Role, Version } from '../../lib/types.js';
import { SessionHud } from '../sessions/session-hud.js';
import { CODE_LABEL, explain, formatClock, formatDuration, shortHash, tone } from '../format.js';

interface Persona {
  id: string;
  name: string;
  roles: Role[];
  badge: string;
}
const ALICE: Persona = { id: 'alice', name: 'Alice', roles: ['viewer'], badge: 'viewer' };
const MO: Persona = { id: 'mo', name: 'Mo', roles: ['viewer', 'moderator'], badge: 'mod' };
const PERSONAS: Persona[] = [
  ALICE,
  { id: 'bob', name: 'Bob', roles: ['viewer'], badge: 'viewer' },
  { id: 'sam', name: 'Sam', roles: ['viewer', 'subscriber'], badge: 'sub' },
  MO,
];
interface RehearsalEvent {
  id: string;
  channelId: string;
  viewerId: string;
  roles: Role[];
  text: string;
  at: number;
}
const SEED = 42;
const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Rehearsal(props: {
  version: Version | null;
  onPreviewed: (versionId: string) => void;
}) {
  const { version } = props;
  const stage = useRef<HTMLDivElement>(null);
  const [events, setEvents] = useState<RehearsalEvent[]>([]);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [clock, setClock] = useState(0);
  const [persona, setPersona] = useState(ALICE);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const shown = useRef(0);
  const definition = version?.manifest.experience;
  const session = result?.session ?? result?.decisions.at(-1)?.session;
  const command = version?.manifest.trigger.command ?? '!tomato';

  const reset = useCallback(() => {
    request.current?.abort();
    sequence.current++;
    setEvents([]);
    setResult(null);
    setClock(0);
    setBusy(false);
    setPlaying(false);
    setError(null);
    shown.current = 0;
    if (stage.current) clearStage(stage.current);
  }, []);
  useEffect(() => {
    reset();
    setText(command);
  }, [version?.id, command, reset]);
  // A different interaction is a fresh rehearsal: start again as the default viewer.
  useEffect(() => setPersona(ALICE), [version?.id]);
  useEffect(() => () => request.current?.abort(), []);

  const replay = useCallback(
    async (next: RehearsalEvent[]) => {
      if (!version) return;
      const controller = new AbortController();
      request.current?.abort();
      request.current = controller;
      setEvents(next);
      setBusy(true);
      setError(null);
      try {
        const evidence = await api.preview(version.id, next, SEED, controller.signal);
        if (controller.signal.aborted) return;
        setResult(evidence);
        props.onPreviewed(version.id);
        // Deterministic replay re-derives every decision; animate only the new ones.
        const fresh = evidence.decisions.slice(shown.current);
        shown.current = evidence.decisions.length;
        if (stage.current)
          for (const decision of fresh)
            for (const effect of decision.effects)
              launch(stage.current, {
                asset: effect.asset,
                x: effect.x,
                reducedMotion: reducedMotion(),
                label: PERSONAS.find((p) => p.id === decision.viewerId)?.name ?? null,
              });
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof ApiError ? cause.message : 'The rehearsal could not run.');
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [version, props],
  );

  const send = (who: Persona, message: string, at = clock, base = events, id?: string) => {
    const event: RehearsalEvent = {
      id: id ?? `r${base.length}-${Date.now() % 100000}`,
      channelId: 'private-preview',
      viewerId: who.id,
      roles: who.roles,
      text: message,
      at,
    };
    const next = [...base, event];
    void replay(next);
    return next;
  };

  /** A scripted, honest run of the acceptance story, executed by the real engine. */
  async function proof() {
    if (!version) return;
    reset();
    setPlaying(true);
    const run = ++sequence.current;
    const t = version.manifest.trigger;
    const eligible = PERSONAS.find((p) => p.roles.some((r) => t.audience.includes(r))) ?? MO;
    const second =
      PERSONAS.find((p) => p !== eligible && p.roles.some((r) => t.audience.includes(r))) ??
      eligible;
    const outsider = PERSONAS.find((p) => !p.roles.some((r) => t.audience.includes(r)));
    const steps: { who: Persona; text: string; at: number; dup?: boolean }[] = [];
    let at = 0;
    if (definition) {
      const firstTeam = definition.teams[0];
      const secondTeam = definition.teams[1] ?? firstTeam;
      if (firstTeam) steps.push({ who: eligible, text: firstTeam.joinCommand, at: 0 });
      if (secondTeam && second !== eligible)
        steps.push({ who: second, text: secondTeam.joinCommand, at: 0 });
      for (let i = 0; i <= Math.min(definition.resource.perParticipant, 100); i++)
        steps.push({
          who: eligible,
          text: command,
          at: Math.min((at += 100), definition.durationMs - 1),
        });
      if (second !== eligible)
        steps.push({
          who: second,
          text: command,
          at: Math.min((at += 100), definition.durationMs - 1),
        });
      steps.push({
        who: eligible,
        text: command,
        at: Math.min(at + 1, definition.durationMs - 1),
        dup: true,
      });
      if (outsider)
        steps.push({
          who: outsider,
          text: firstTeam?.joinCommand ?? command,
          at: Math.min(at + 1, definition.durationMs - 1),
        });
      steps.push({ who: eligible, text: command, at: definition.durationMs });
    } else {
      for (let i = 0; i < Math.min(t.maxPerViewer, 6) + 1; i++)
        steps.push({ who: eligible, text: command, at: (at += 400) });
      if (second !== eligible) steps.push({ who: second, text: command, at: (at += 400) });
      steps.push({ who: eligible, text: command, at: (at += 10), dup: true });
      steps.push({ who: second, text: 'hello chat!', at: (at += 400) });
      if (outsider) steps.push({ who: outsider, text: command, at: (at += 400) });
      // The first accepted action stops counting exactly one window after it happened.
      steps.push({
        who: eligible,
        text: command,
        at: Math.max(at + 1, (steps[0]?.at ?? 0) + t.windowMs),
      });
    }
    let list: RehearsalEvent[] = [];
    for (const step of steps) {
      if (sequence.current !== run) return;
      const dupId = step.dup ? list.find((event) => event.text === command)?.id : undefined;
      list = [
        ...list,
        {
          id: dupId ?? `p${list.length}`,
          channelId: 'private-preview',
          viewerId: step.who.id,
          roles: step.who.roles,
          text: step.text,
          at: step.at,
        },
      ];
      setClock(step.at);
      await replay(list);
      await new Promise((resolve) => setTimeout(resolve, reducedMotion() ? 150 : 650));
    }
    if (sequence.current === run) setPlaying(false);
  }

  const decisions = result?.decisions ?? [];
  const allowances = useMemo(() => {
    const map = new Map<string, Decision>();
    for (const decision of decisions)
      if (decision.viewerId && decision.allowance) map.set(decision.viewerId, decision);
    return map;
  }, [decisions]);
  const accepted = decisions.filter((d) => d.code === 'ACCEPTED').length;
  const blocked = decisions.filter((d) => d.code !== 'ACCEPTED').length;
  const disabled = !version || busy || playing;

  return (
    <section className="card rehearsal" aria-labelledby="rehearsal-heading">
      <header className="card-head">
        <div>
          <p className="step-label">
            <span>3</span> Preview · private rehearsal
          </p>
          <h2 id="rehearsal-heading">
            {version ? `Rehearse “${version.title}” v${version.number}` : 'Rehearsal stage'}
          </h2>
        </div>
        <span
          className="pill private"
          title="Rehearsal output never reaches your stream overlay or Twitch"
        >
          🔒 Private · not on stream
        </span>
      </header>

      <div className="stage-frame">
        <div
          ref={stage}
          className="stage"
          role="img"
          aria-label={`Private overlay preview. ${accepted} effects shown, ${blocked} messages blocked or ignored.`}
        >
          <div className="stage-cam" aria-hidden="true">
            <span>Your camera</span>
          </div>
          {!version && <p className="stage-empty">Generate an interaction to rehearse it here.</p>}
          {version && decisions.length === 0 && (
            <p className="stage-empty">
              Pick a viewer and send {command} — or run the proof sequence.
            </p>
          )}
        </div>
        <div className="stage-hud" aria-hidden="true">
          <span className="mono">⏱ {formatClock(clock)}</span>
          <span>
            {accepted} thrown · {blocked} blocked/ignored
          </span>
        </div>
      </div>

      {definition && session && (
        <SessionHud
          definition={definition}
          snapshot={session}
          now={clock}
          viewerId={persona.id}
          label={`${definition.title} rehearsal session`}
        />
      )}
      {definition && (
        <div className="rehearsal-actions" role="group" aria-label="Session participation">
          {definition.teams.map((team) => (
            <button
              key={team.id}
              type="button"
              className="button small"
              disabled={disabled || events.length >= 120}
              onClick={() => send(persona, team.joinCommand)}
            >
              Join {team.label}
            </button>
          ))}
          <button
            type="button"
            className="button small"
            disabled={disabled || events.length >= 120}
            onClick={() => send(persona, command)}
          >
            Contribute {command}
          </button>
          <button
            type="button"
            className="button small ghost"
            disabled={disabled || events.length >= 120}
            onClick={() => {
              const deadline = session?.deadlineAt ?? definition.durationMs;
              setClock(deadline);
              send(persona, 'rehearsal clock advance', deadline);
            }}
          >
            Advance to deadline
          </button>
          <p className="note">Synthetic viewers and clock · resources last for the whole round.</p>
        </div>
      )}
      <div className="personas" role="group" aria-label="Synthetic viewers">
        {PERSONAS.map((p) => {
          const d = allowances.get(p.id);
          const max =
            definition?.resource.perParticipant ?? version?.manifest.trigger.maxPerViewer ?? 3;
          const participant =
            session && Object.hasOwn(session.participants, p.id)
              ? session.participants[p.id]
              : undefined;
          const used = definition
            ? max - (participant?.remaining ?? max)
            : d?.allowance
              ? d.allowance.nextAt !== null && d.allowance.nextAt <= clock
                ? 0
                : d.allowance.used
              : 0;
          const eligible = version
            ? p.roles.some((r) => version.manifest.trigger.audience.includes(r))
            : true;
          return (
            <button
              key={p.id}
              type="button"
              className="persona"
              aria-pressed={persona.id === p.id}
              onClick={() => setPersona(p)}
              disabled={!version || playing}
            >
              <span className="avatar" data-persona={p.id} aria-hidden="true">
                {p.name[0]}
              </span>
              <span className="persona-name">
                {p.name} <small>{p.badge}</small>
              </span>
              {eligible ? (
                <span className="meter" aria-label={`${Math.max(0, max - used)} of ${max} left`}>
                  {Array.from({ length: Math.min(max, 10) }, (_, i) => (
                    <i key={i} data-on={i >= used} />
                  ))}
                </span>
              ) : (
                <span className="meter-note">not eligible</span>
              )}
            </button>
          );
        })}
      </div>

      <form
        className="chat-input"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled && text.trim()) send(persona, text.trim());
        }}
      >
        <label className="sr-only" htmlFor="rehearsal-text">
          Chat message as {persona.name}
        </label>
        <span className="as" aria-hidden="true">
          {persona.name}:
        </span>
        <input
          id="rehearsal-text"
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
          disabled={!version || playing}
        />
        <button
          type="submit"
          className="button primary small"
          disabled={disabled || !text.trim() || events.length >= 120}
        >
          Send
        </button>
      </form>
      <div className="rehearsal-actions">
        <button
          type="button"
          className="button small"
          onClick={() => void proof()}
          disabled={disabled}
        >
          ▶ Run proof sequence
        </button>
        <button
          type="button"
          className="button small ghost"
          onClick={() => {
            const at = clock + 10_000;
            setClock(at);
            if (definition) send(persona, 'rehearsal clock advance', at);
          }}
          disabled={disabled || events.length >= 120}
        >
          +10 s
        </button>
        <button
          type="button"
          className="button small ghost"
          onClick={() => setClock((c) => c + (version?.manifest.trigger.windowMs ?? 60_000))}
          hidden={Boolean(definition)}
          disabled={!version || playing}
        >
          Skip {formatDuration(version?.manifest.trigger.windowMs ?? 60_000)}
        </button>
        <button
          type="button"
          className="button small ghost"
          onClick={() => {
            const last = events.at(-1);
            if (last) void replay([...events, { ...last, at: Math.max(last.at, clock) }]);
          }}
          disabled={disabled || !events.length}
        >
          Redeliver last
        </button>
        <button type="button" className="button small ghost" onClick={reset} disabled={!version}>
          Reset
        </button>
      </div>
      {error && (
        <p role="alert" className="answer bad">
          {error}
        </p>
      )}

      <ol className="decisions" aria-label="Host decisions" aria-live="polite">
        {[...decisions]
          .reverse()
          .slice(0, 8)
          .map((decision, reverseIndex) => {
            const index = decisions.length - 1 - reverseIndex;
            const event = events[index];
            const who =
              PERSONAS.find((p) => p.id === decision.viewerId)?.name ??
              decision.viewerId ??
              'viewer';
            return (
              <li
                key={`${index}-${decision.eventId}`}
                data-testid="decision"
                data-tone={tone(decision.code)}
              >
                <span className={`badge ${tone(decision.code)}`}>
                  {decision.code === 'ACCEPTED' && definition
                    ? 'Accepted'
                    : CODE_LABEL[decision.code]}
                </span>
                <span>
                  {version
                    ? explain(decision, event?.text ?? '', who, version.manifest)
                    : decision.reason}
                </span>
                {decision.session && (
                  <span className="session-evidence">
                    {decision.session.phase} · revision {decision.session.revision} ·{' '}
                    {Object.entries(decision.session.scores)
                      .map(([team, score]) => `${team}: ${score}`)
                      .join(', ')}
                  </span>
                )}
                <span className="mono muted">{formatClock(event?.at ?? 0)}</span>
              </li>
            );
          })}
      </ol>
      {result && (
        <p className="replay-proof mono">
          Deterministic replay · seed {result.seed} · {events.length} events · {result.durationMs}{' '}
          ms · artifact {shortHash(result.artifactId)}
        </p>
      )}
    </section>
  );
}
