import './production.css';
import type { Version } from '../../lib/types.js';
import { PanelCard, type Tone } from '../panel-kit.js';
import type { ProductionState } from './contracts.js';
import { Connector } from './connector.js';
import { ObsSetup } from './obs-setup.js';
import { ProductionMappings } from './mappings.js';
import { useProduction } from './use-production.js';

function summary(state: ProductionState | null, panic: boolean): { text: string; tone: Tone } {
  if (panic) return { text: 'Stopped', tone: 'warn' };
  if (!state) return { text: 'Loading…', tone: 'muted' };
  const { obs, streamerbot } = state.connections;
  if (obs.status === 'error' || streamerbot.status === 'error')
    return { text: 'Needs attention', tone: 'bad' };
  const live = state.obsReview?.status === 'live';
  const names = [
    obs.status === 'connected' && 'OBS',
    streamerbot.status === 'connected' && 'Streamer.bot',
  ].filter(Boolean);
  if (!names.length)
    return { text: live ? 'Overlay placed · offline' : 'Not connected', tone: 'muted' };
  return { text: `${names.join(' + ')} connected${live ? ' · overlay live' : ''}`, tone: 'good' };
}
const time = (at: number) => new Date(at).toLocaleTimeString();

export function ProductionPanel({ versions, panic }: { versions: Version[]; panic: boolean }) {
  const { state, busy, error, mutate } = useProduction();
  return (
    <PanelCard
      title="Production setup"
      subtitle="Place Riff in OBS and let selected Streamer.bot actions start or pause interactions."
      className="production-panel"
      status={summary(state, panic)}
      actions={
        <a className="button small ghost" href="/dock/" target="_blank" rel="noreferrer">
          Control dock ↗
        </a>
      }
    >
      <p className="panel-lead">
        Riff connects from its own server to your tools’ WebSocket servers, with their passwords
        sealed on the server. On the streaming PC use <code>127.0.0.1</code>; a hosted Riff needs a
        reachable, secured endpoint. The emergency stop fences every external action instantly.
      </p>
      {!state ? (
        error ? (
          <p role="alert" className="answer bad">
            {error}
          </p>
        ) : (
          <p className="panel-hint">Loading production status…</p>
        )
      ) : (
        <>
          <div className="production-connectors">
            <Connector kind="obs" state={state} busy={busy} panic={panic} mutate={mutate} />
            <Connector kind="streamerbot" state={state} busy={busy} panic={panic} mutate={mutate} />
          </div>
          <ObsSetup state={state} busy={busy} panic={panic} mutate={mutate} />
          <ProductionMappings
            state={state}
            versions={versions}
            busy={busy}
            panic={panic}
            mutate={mutate}
          />
          {state.recent.length > 0 && (
            <details>
              <summary>Recent production activity ({state.recent.length})</summary>
              <ol className="panel-timeline">
                {[...state.recent].reverse().map((entry, i) => (
                  <li key={`${entry.at}-${i}`}>
                    <time>{time(entry.at)}</time>
                    <span>{entry.message}</span>
                  </li>
                ))}
              </ol>
            </details>
          )}
          {error && (
            <p role="alert" className="answer bad">
              {error}
            </p>
          )}
        </>
      )}
    </PanelCard>
  );
}
