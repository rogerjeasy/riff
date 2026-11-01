import './production.css';
import type { Version } from '../../lib/types.js';
import { PanelCard, type Tone } from '../panel-kit.js';
import type { ProductionState } from './contracts.js';
import { Connector } from './connector.js';
import { ObsSetup } from './obs-setup.js';
import { ProductionMappings } from './mappings.js';
import { ImportWizard } from './import-wizard.js';
import { useProduction } from './use-production.js';

function summary(state: ProductionState | null, panic: boolean): { text: string; tone: Tone } {
  if (panic) return { text: 'Stopped', tone: 'warn' };
  if (!state) return { text: 'Loading…', tone: 'muted' };
  const { obs, streamerbot, firebot } = state.connections;
  if ([obs, streamerbot, firebot].some((c) => c.status === 'error'))
    return { text: 'Needs attention', tone: 'bad' };
  const live = state.obsReview?.status === 'live';
  const names = [
    obs.status === 'connected' && 'OBS',
    streamerbot.status === 'connected' && 'Streamer.bot',
    firebot.status === 'connected' && 'Firebot',
  ].filter(Boolean);
  if (!names.length)
    return { text: live ? 'Overlay placed · offline' : 'Not connected', tone: 'muted' };
  return { text: `${names.join(' + ')} connected${live ? ' · overlay live' : ''}`, tone: 'good' };
}
const time = (at: number) => new Date(at).toLocaleTimeString();

export function ProductionPanel({
  versions,
  panic,
  onDraftIntent,
}: {
  versions: Version[];
  panic: boolean;
  /** Hands an imported interaction description to the composer for editing and testing. */
  onDraftIntent?: (text: string) => void;
}) {
  const { state, busy, error, mutate, send } = useProduction();
  return (
    <PanelCard
      title="Production setup"
      subtitle="Place Riff in OBS, bridge Streamer.bot or Firebot actions, and import existing setups."
      className="production-panel"
      status={summary(state, panic)}
      actions={
        <a className="button small ghost" href="/dock/" target="_blank" rel="noreferrer">
          Control dock ↗
        </a>
      }
    >
      <p className="panel-lead">
        Riff connects from its own server to your tools’ local servers; passwords and keys are used
        only for the live connection and never stored. On the streaming PC use{' '}
        <code>127.0.0.1</code>; a hosted Riff needs a reachable, secured endpoint (Firebot is
        local-network only). The emergency stop fences every external action instantly.
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
            <Connector kind="firebot" state={state} busy={busy} panic={panic} mutate={mutate} />
          </div>
          <ObsSetup state={state} busy={busy} panic={panic} mutate={mutate} />
          <ProductionMappings
            state={state}
            versions={versions}
            busy={busy}
            panic={panic}
            mutate={mutate}
          />
          <ImportWizard
            state={state}
            versions={versions}
            busy={busy}
            panic={panic}
            send={send}
            onDraftIntent={onDraftIntent}
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
