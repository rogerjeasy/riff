import './channel-points.css';
import { useEffect, useId, useRef, useState } from 'react';
import { PanelCard, Segmented, type Tone } from '../panel-kit.js';
import {
  accessProblem,
  channelPointsSchema,
  type ChannelPointsState,
  type Redemption,
  type Reward,
} from './contracts.js';
import { useFeature } from './use-feature.js';

type Mutate = (key: string, url: string, body?: unknown) => Promise<boolean>;
const POLICY_OPTIONS = [
  { value: 'auto', label: 'Automatic', hint: 'Fulfil accepted redemptions; refund refused ones' },
  { value: 'manual', label: 'I review', hint: 'Accepted redemptions wait in the queue for you' },
] as const;
const REDEMPTION_LABEL: Record<Redemption['status'], [string, Tone]> = {
  queued: ['Waiting for you', 'warn'],
  fulfilled: ['Fulfilled', 'good'],
  refunded: ['Refunded', 'muted'],
  failed: ['Needs retry', 'bad'],
};
const time = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** F22 creator console: Riff-managed rewards, their interaction links and the redemption queue. */
export function ChannelPointsPanel() {
  const { state, loadError, error, busy, mutate } = useFeature(
    '/api/channel-points',
    channelPointsSchema,
  );
  const problem = state ? accessProblem(state, 'Channel Points rewards') : null;
  const waiting = state?.redemptions.filter((r) => r.status === 'queued' || r.status === 'failed');
  const status: { text: string; tone: Tone } = !state
    ? { text: loadError ? 'Unavailable' : 'Loading…', tone: loadError ? 'bad' : 'muted' }
    : problem
      ? { text: state.connected ? 'Needs setup' : 'Not connected', tone: 'muted' }
      : state.panicked
        ? { text: 'Stopped · refunding', tone: 'bad' }
        : waiting?.length
          ? { text: `${waiting.length} waiting`, tone: 'warn' }
          : state.rewards.some((r) => r.automationId && !r.paused)
            ? { text: 'Live', tone: 'live' }
            : {
                text: `${state.rewards.length} reward${state.rewards.length === 1 ? '' : 's'}`,
                tone: 'muted',
              };
  return (
    <PanelCard
      title="Channel Points"
      subtitle="Rewards Riff creates on Twitch, linked to an interaction. Riff fulfils or refunds; viewers’ code never does."
      status={status}
      className="points-panel"
    >
      {!state ? (
        <p className="panel-hint" role={loadError ? 'alert' : 'status'}>
          {loadError || 'Loading Channel Points…'}
        </p>
      ) : (
        <div className="points-layout">
          <Access state={state} problem={problem} mutate={mutate} busy={busy} />
          {!problem && (
            <>
              <RewardList state={state} mutate={mutate} busy={busy} />
              <NewReward state={state} mutate={mutate} busy={busy} />
              <Queue redemptions={state.redemptions} mutate={mutate} busy={busy} />
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="answer bad">
          {error}
        </p>
      )}
    </PanelCard>
  );
}

function Access({
  state,
  problem,
  mutate,
  busy,
}: {
  state: ChannelPointsState;
  problem: ReturnType<typeof accessProblem>;
  mutate: Mutate;
  busy: string | null;
}) {
  return (
    <div className="points-access">
      {problem ? (
        <div className="panel-callout" data-tone="warn">
          <p>{problem.text}</p>
          {problem.action && (
            <p>
              <a
                className="button small"
                href={problem.action === 'connect' ? '/auth/twitch' : state.consent.url}
              >
                {problem.action === 'connect' ? 'Connect Twitch' : 'Allow Channel Points access'}
              </a>{' '}
              <span className="panel-hint">
                Twitch asks you to approve <code>channel:manage:redemptions</code>. Chat access is
                kept.
              </span>
            </p>
          )}
        </div>
      ) : (
        <p className="panel-lead">
          Riff can only manage rewards it created — Twitch reserves each reward for the app that
          made it. Rewards from your Twitch dashboard stay there. Redemptions are admitted like
          chat: per-viewer allowance, channel budget and duplicates are enforced by Riff before
          anything shows.
        </p>
      )}
      <div className="points-meta">
        <span className={`badge ${state.eligibility === 'ineligible' ? 'bad' : 'muted'}`}>
          {state.eligibility === 'unknown'
            ? 'Eligibility not checked'
            : state.eligibility === 'ineligible'
              ? 'Not Affiliate/Partner'
              : state.eligibility === 'partner'
                ? 'Partner'
                : 'Affiliate'}
        </span>
        {state.subscription === 'failed' && (
          <span className="badge bad">Redemption events unavailable — reconnect Twitch</span>
        )}
        {state.subscription === 'subscribed' && (
          <span className="badge good">Receiving redemptions</span>
        )}
        {state.connected && (
          <button
            type="button"
            className="button small ghost"
            disabled={busy !== null}
            onClick={() => void mutate('refresh', '/api/channel-points/refresh')}
          >
            {busy === 'refresh' ? 'Checking…' : 'Check with Twitch'}
          </button>
        )}
      </div>
      {state.panicked && (
        <p className="panel-callout" data-tone="warn" role="status">
          Riff is stopped. Riff rewards were paused on Twitch and any redemption is refunded until
          you resume and un-pause them.
        </p>
      )}
      {state.lastError && <p className="panel-problem">{state.lastError}</p>}
    </div>
  );
}

function RewardList({
  state,
  mutate,
  busy,
}: {
  state: ChannelPointsState;
  mutate: Mutate;
  busy: string | null;
}) {
  if (!state.rewards.length)
    return (
      <p className="panel-hint points-empty">
        No Riff rewards yet. Create one below, then link it to an interaction made for Channel
        Points (describe it as “when someone redeems ‘Hydrate’, …”).
      </p>
    );
  return (
    <section aria-labelledby="points-rewards-heading" className="points-section">
      <h3 id="points-rewards-heading">Riff rewards</h3>
      <ul className="points-rewards">
        {state.rewards.map((reward) => (
          <RewardRow key={reward.id} reward={reward} state={state} mutate={mutate} busy={busy} />
        ))}
      </ul>
    </section>
  );
}

function RewardRow({
  reward,
  state,
  mutate,
  busy,
}: {
  reward: Reward;
  state: ChannelPointsState;
  mutate: Mutate;
  busy: string | null;
}) {
  const id = useId();
  const [automationId, setAutomationId] = useState(reward.automationId ?? '');
  const [policy, setPolicy] = useState<Reward['policy']>(reward.policy);
  const [editing, setEditing] = useState(false);
  const [cost, setCost] = useState(String(reward.cost));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setAutomationId(reward.automationId ?? '');
    setPolicy(reward.policy);
  }, [reward.automationId, reward.policy]);
  useEffect(() => {
    if (confirmDelete) confirmRef.current?.focus();
  }, [confirmDelete]);
  const linked = state.automations.find((a) => a.id === automationId);
  const mismatch = linked && linked.reward.toLowerCase() !== reward.title.toLowerCase();
  const dirty = automationId !== (reward.automationId ?? '') || policy !== reward.policy;
  const pending = busy !== null;
  const tone: Tone = !reward.enabled
    ? 'muted'
    : reward.paused
      ? 'warn'
      : reward.automationId
        ? 'live'
        : 'muted';
  return (
    <li className="points-reward">
      <div className="points-reward-head">
        <div>
          <b>{reward.title}</b>
          <span className="panel-hint">
            {reward.cost.toLocaleString()} points
            {reward.cooldownSeconds ? ` · ${reward.cooldownSeconds}s cooldown` : ''}
            {reward.inputRequired ? ' · asks for text' : ''}
          </span>
        </div>
        <span className={`pill ${tone}`}>
          {!reward.enabled
            ? 'Hidden'
            : reward.paused
              ? 'Paused'
              : reward.automationId
                ? 'Linked'
                : 'Not linked'}
        </span>
      </div>
      <div className="points-link">
        <label htmlFor={`${id}-automation`}>Triggers interaction</label>
        <select
          id={`${id}-automation`}
          value={automationId}
          disabled={pending}
          onChange={(e) => setAutomationId(e.target.value)}
        >
          <option value="">Not linked (redemptions are refunded)</option>
          {state.automations.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title} — expects “{a.reward}”{a.status === 'live' ? '' : ` (${a.status})`}
            </option>
          ))}
        </select>
        {!state.automations.length && (
          <span className="panel-hint">No interaction uses a Channel Points trigger yet.</span>
        )}
        {mismatch && (
          <span className="panel-hint" role="note">
            This interaction was written for “{linked.reward}”; it will run for “{reward.title}”.
          </span>
        )}
        <span className="points-label">When a redemption is accepted</span>
        <Segmented
          label={`Settlement for ${reward.title}`}
          value={policy}
          options={POLICY_OPTIONS}
          onChange={setPolicy}
          disabled={pending}
        />
        <span className="panel-hint">
          Refused redemptions (limits, budget, stopped) are always refunded.
        </span>
      </div>
      <div className="panel-actions">
        <button
          type="button"
          className="button small"
          disabled={!dirty || pending}
          onClick={() =>
            void mutate(`link-${reward.id}`, `/api/channel-points/rewards/${reward.id}/link`, {
              automationId: automationId || null,
              policy,
            })
          }
        >
          {busy === `link-${reward.id}` ? 'Saving…' : 'Save link'}
        </button>
        <button
          type="button"
          className="button small ghost"
          disabled={pending || (reward.paused && state.panicked)}
          title={reward.paused && state.panicked ? 'Resume the channel first' : undefined}
          onClick={() =>
            void mutate(`pause-${reward.id}`, `/api/channel-points/rewards/${reward.id}`, {
              paused: !reward.paused,
            })
          }
        >
          {busy === `pause-${reward.id}`
            ? 'Updating…'
            : reward.paused
              ? 'Un-pause on Twitch'
              : 'Pause on Twitch'}
        </button>
        <button
          type="button"
          className="button small ghost"
          aria-expanded={editing}
          disabled={pending}
          onClick={() => setEditing((v) => !v)}
        >
          Edit cost
        </button>
        {!confirmDelete ? (
          <button
            type="button"
            className="button small ghost"
            disabled={pending}
            onClick={() => setConfirmDelete(true)}
          >
            Delete…
          </button>
        ) : (
          <span
            className="points-confirm"
            role="group"
            aria-label={`Confirm deleting ${reward.title}`}
          >
            <span>
              Delete “{reward.title}” from Twitch? Waiting redemptions are marked fulfilled by
              Twitch.
            </span>
            <button
              ref={confirmRef}
              type="button"
              className="button small stop"
              disabled={pending}
              onClick={() =>
                void mutate(
                  `delete-${reward.id}`,
                  `/api/channel-points/rewards/${reward.id}/delete`,
                  {
                    confirm: true,
                  },
                )
              }
            >
              {busy === `delete-${reward.id}` ? 'Deleting…' : 'Delete reward'}
            </button>
            <button
              type="button"
              className="button small ghost"
              onClick={() => setConfirmDelete(false)}
            >
              Keep
            </button>
          </span>
        )}
      </div>
      {editing && (
        <form
          className="points-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void mutate(`cost-${reward.id}`, `/api/channel-points/rewards/${reward.id}`, {
              cost: Number(cost),
            }).then((ok) => ok && setEditing(false));
          }}
        >
          <label htmlFor={`${id}-cost`}>Cost in points</label>
          <input
            id={`${id}-cost`}
            type="number"
            inputMode="numeric"
            min={1}
            required
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
          <button className="button small" disabled={pending || !(Number(cost) >= 1)}>
            {busy === `cost-${reward.id}` ? 'Saving…' : 'Save cost'}
          </button>
        </form>
      )}
    </li>
  );
}

function NewReward({
  state,
  mutate,
  busy,
}: {
  state: ChannelPointsState;
  mutate: Mutate;
  busy: string | null;
}) {
  const id = useId();
  const suggestions = state.automations
    .map((a) => a.reward)
    .filter(
      (title) => title && !state.rewards.some((r) => r.title.toLowerCase() === title.toLowerCase()),
    );
  const [title, setTitle] = useState('');
  const [cost, setCost] = useState('500');
  const [prompt, setPrompt] = useState('');
  const [inputRequired, setInputRequired] = useState(false);
  const [cooldown, setCooldown] = useState('');
  const full = state.rewards.length >= state.limits.rewards;
  const valid =
    title.trim().length > 0 &&
    Array.from(title.trim()).length <= state.limits.titleLength &&
    Number(cost) >= 1 &&
    (cooldown === '' || Number(cooldown) >= 1);
  const disabled = busy !== null || state.panicked || full;
  return (
    <section aria-labelledby={`${id}-heading`} className="points-section">
      <h3 id={`${id}-heading`}>Create a Riff reward</h3>
      {suggestions.length > 0 && (
        <p className="panel-hint">
          Interactions are waiting for:{' '}
          {suggestions.map((s) => (
            <button key={s} type="button" className="chip" onClick={() => setTitle(s)}>
              {s}
            </button>
          ))}
        </p>
      )}
      <form
        className="points-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          void mutate('create', '/api/channel-points/rewards', {
            title: title.trim(),
            cost: Number(cost),
            prompt,
            inputRequired,
            cooldownSeconds: cooldown === '' ? null : Number(cooldown),
          }).then((ok) => {
            if (ok) {
              setTitle('');
              setPrompt('');
              setInputRequired(false);
              setCooldown('');
            }
          });
        }}
      >
        <fieldset disabled={disabled}>
          <legend className="sr-only">New reward</legend>
          <div className="points-grid">
            <label htmlFor={`${id}-title`}>
              Title{' '}
              <span className="panel-hint">
                ({Array.from(title).length}/{state.limits.titleLength})
              </span>
            </label>
            <input
              id={`${id}-title`}
              required
              maxLength={state.limits.titleLength}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Hydrate"
            />
            <label htmlFor={`${id}-cost`}>Cost in points</label>
            <input
              id={`${id}-cost`}
              type="number"
              inputMode="numeric"
              min={1}
              required
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
            <label htmlFor={`${id}-cooldown`}>
              Cooldown <span className="panel-hint">(seconds, optional)</span>
            </label>
            <input
              id={`${id}-cooldown`}
              type="number"
              inputMode="numeric"
              min={1}
              value={cooldown}
              onChange={(e) => setCooldown(e.target.value)}
              placeholder="60"
            />
            <label htmlFor={`${id}-prompt`}>
              Prompt <span className="panel-hint">(shown to viewers, optional)</span>
            </label>
            <input
              id={`${id}-prompt`}
              maxLength={state.limits.promptLength}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Remind me to drink water"
            />
          </div>
          <label className="panel-checkbox">
            <input
              type="checkbox"
              checked={inputRequired}
              onChange={(e) => setInputRequired(e.target.checked)}
            />
            Ask viewers for text (sanitized and capped at 500 characters before Riff sees it)
          </label>
          <div className="panel-actions">
            <button className="button" disabled={!valid}>
              {busy === 'create' ? 'Creating on Twitch…' : 'Create reward'}
            </button>
            <span className="panel-hint">
              {full
                ? 'Twitch allows 50 custom rewards per channel.'
                : state.panicked
                  ? 'Resume the channel to create rewards.'
                  : 'Riff keeps Twitch’s request queue on so refunds stay possible.'}
            </span>
          </div>
        </fieldset>
      </form>
    </section>
  );
}

function Queue({
  redemptions,
  mutate,
  busy,
}: {
  redemptions: Redemption[];
  mutate: Mutate;
  busy: string | null;
}) {
  return (
    <section aria-labelledby="points-queue-heading" className="points-section">
      <h3 id="points-queue-heading">Redemptions</h3>
      {!redemptions.length ? (
        <p className="panel-hint">
          No redemptions yet. They appear here as soon as viewers redeem a Riff reward.
        </p>
      ) : (
        <ul className="points-queue" aria-live="polite">
          {redemptions.map((r) => {
            const [label, tone] = REDEMPTION_LABEL[r.status];
            const open = r.status === 'queued' || r.status === 'failed';
            return (
              <li key={r.id} className="points-redemption" data-status={r.status}>
                <div>
                  <b>{r.viewerName}</b> redeemed <b>{r.rewardTitle}</b>{' '}
                  <time className="panel-hint" dateTime={new Date(r.receivedAt).toISOString()}>
                    {time(r.receivedAt)}
                  </time>
                  {r.input && <q className="points-input">{r.input}</q>}
                  {r.reason && <span className="panel-hint">{r.reason}</span>}
                </div>
                <div className="points-redemption-side">
                  <span className={`pill ${tone}`}>{label}</span>
                  {open && (
                    <>
                      <button
                        type="button"
                        className="button small"
                        disabled={busy !== null}
                        onClick={() =>
                          void mutate(`fulfil-${r.id}`, `/api/channel-points/redemptions/${r.id}`, {
                            action: 'fulfil',
                          })
                        }
                      >
                        {busy === `fulfil-${r.id}` ? 'Fulfilling…' : 'Fulfil'}
                      </button>
                      <button
                        type="button"
                        className="button small ghost"
                        disabled={busy !== null}
                        onClick={() =>
                          void mutate(`refund-${r.id}`, `/api/channel-points/redemptions/${r.id}`, {
                            action: 'refund',
                          })
                        }
                      >
                        {busy === `refund-${r.id}` ? 'Refunding…' : 'Refund'}
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
