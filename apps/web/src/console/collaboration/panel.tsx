import { useCallback, useEffect, useRef, useState } from 'react';
import type { Version } from '../../lib/types.js';
import { CODE_LABEL } from '../format.js';
import { collaborationApi, type SharedControl } from './api.js';
import {
  inviteCode,
  parseInvite,
  publicFields,
  roleSchema,
  rolesSchema,
  type CollaborationStatus,
  type MemberReview,
  type SharedProjection,
  type SharedRole,
  type SharedView,
} from '../../collaboration/schema.js';
import './panel.css';

type ShareableVersion = Pick<
  Version,
  'id' | 'title' | 'number' | 'status' | 'manifest' | 'evidence'
>;
type MemberState = CollaborationStatus['member']['state'];
const fieldNames = {
  score: 'Shared score and goal',
  remaining: 'Time left in the round',
  contributions: 'This channel’s contributions',
  mechanics: 'Bursts and milestone tier',
};
type Rules = NonNullable<ShareableVersion['manifest']['experience']>;
/** Each role action available in one definition, with the command it maps to. */
function roleActions(rules: Rules | null | undefined) {
  if (!rules) return [];
  const actions = [{ value: 'contribute', label: `Contribute (${rules.contribution.command})` }];
  const m = rules.version === 2 ? rules.mechanics : undefined;
  if (m?.burst?.command)
    actions.push({ value: 'burst', label: `${m.burst.label} burst (${m.burst.command})` });
  for (const milestone of m?.milestones ?? [])
    if (milestone.unlock)
      actions.push({
        value: `unlock:${milestone.id}`,
        label: `${milestone.label} unlock (${milestone.unlock.command})`,
      });
  return actions;
}
/** What one role's command does, in words a creator can approve. */
function actionText(rules: Rules, action: string | undefined) {
  const m = rules.version === 2 ? rules.mechanics : undefined;
  if (action === 'burst' && m?.burst)
    return `Each one joins a ${m.burst.label} burst: ${m.burst.participants} different viewers within ${Math.ceil(m.burst.windowMs / 1000)}s add ${m.burst.points} points.`;
  const milestone = m?.milestones.find((x) => `unlock:${x.id}` === action);
  if (milestone?.unlock)
    return `After ${milestone.label} is reached, each one spends one ${rules.resource.name} for ${milestone.unlock.points} points.`;
  return `Each one counts as one tested ${rules.contribution.command}.`;
}
const DECISION: Record<string, string> = {
  POLICY_WAIT: 'Host chose to wait',
  POLICY_WAIT_EXPIRED: 'Wait ran out',
  POLICY_RESUMED: 'Resumed after the channel returned',
  POLICY_CONTINUE: 'Host continued without the missing channel',
  POLICY_END: 'Host ended the round',
  HANDOFF: 'Raid handed the round to another channel',
};
const MEMBER_STATE: Record<MemberState, string> = {
  idle: 'Not in a shared round',
  review: 'Reviewing an invitation',
  connected: 'Connected',
  paused: 'Coordinator unreachable · paused',
  stopped: 'Not connected',
};
const ROUND_STATE: Record<SharedView['status'], { text: string; tone: string }> = {
  waiting: { text: 'Waiting for channels', tone: 'warn' },
  running: { text: 'Live', tone: 'good' },
  paused: { text: 'Paused', tone: 'warn' },
  finished: { text: 'Finished', tone: 'muted' },
};
const CONTROL_PENDING: Record<SharedControl, string> = {
  start: 'Starting shared round',
  resume: 'Resuming shared round',
  pause: 'Pausing shared round',
  wait: 'Waiting for the missing channel',
  continue: 'Continuing without the missing channel',
  end: 'Ending the shared round',
};
const CONTROL_DONE: Record<SharedControl, string> = {
  start: 'Shared round is live.',
  resume: 'Shared round is live.',
  pause: 'Shared round paused.',
  wait: 'Waiting up to 2 minutes. Every channel sees this.',
  continue: 'Shared round continues without the missing channel.',
  end: 'Shared round ended. Final results stay on every overlay.',
};
const roleDraft = (index: number, channelId = ''): SharedRole => ({
  id: `role-${index + 1}`,
  label: index === 0 ? 'Repair shields' : index === 1 ? 'Steer ship' : `Role ${index + 1}`,
  channelId,
  command: index === 0 ? '!repair' : index === 1 ? '!steer' : `!help${index + 1}`,
  required: true,
  fields: ['score', 'remaining', 'contributions'],
});
const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const outcome = (code: string) =>
  code === 'ACCEPTED'
    ? 'Counted'
    : ((CODE_LABEL as Record<string, string | undefined>)[code] ?? code.toLowerCase());
/** What is wrong with one role, in words a creator can act on. */
function roleProblem(roles: SharedRole[], index: number): string | null {
  const role = roles[index];
  if (!role) return null;
  if (!role.label.trim()) return 'Give this role a name viewers will see.';
  if (!/^\d{1,32}$/.test(role.channelId))
    return index === 0
      ? 'Connect Twitch so your channel ID fills in.'
      : 'Add this channel’s numeric Twitch ID (they can copy it from their Shared channels panel).';
  if (!roleSchema.shape.command.safeParse(role.command).success)
    return 'Commands start with ! and use lowercase letters, numbers, - or _ (for example !steer).';
  if (roles.some((r, i) => i !== index && r.channelId === role.channelId))
    return 'Each role needs a different channel.';
  if (roles.some((r, i) => i !== index && r.command === role.command))
    return 'Each role needs its own command.';
  return null;
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function Progress({ projection }: { projection: SharedProjection }) {
  if (projection.score === undefined) return null;
  const target = projection.target;
  const percent = target ? Math.min(100, Math.round((projection.score / target) * 100)) : null;
  return (
    <div className="shared-progress">
      <div className="shared-progress-row">
        <strong>
          {projection.score}
          {target !== undefined ? ` / ${target}` : ''} points
        </strong>
        {percent !== null && <span>{percent}%</span>}
      </div>
      {percent !== null && (
        <div
          className="shared-bar"
          role="progressbar"
          aria-label="Shared goal progress"
          aria-valuemin={0}
          aria-valuemax={target}
          aria-valuenow={projection.score}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}

function Review({ review, own }: { review: MemberReview; own: boolean }) {
  const role = review.contract.roles.find((r) => r.id === review.roleId);
  if (!role) return <p role="alert">This review has no matching role. Request a new invitation.</p>;
  const manifest = review.contract.artifact.manifest;
  const rules = manifest.experience;
  const others = review.contract.roles.filter((r) => r.id !== role.id);
  const passed = review.verification.stages.filter((s) => s.status === 'passed').length;
  return (
    <section className="shared-review" aria-label="Invitation review">
      <p className="shared-eyebrow">{own ? 'Your own role' : 'Invitation'} · nothing is live yet</p>
      <h3>
        Play <strong>{review.contract.title}</strong> as <strong>{role.label}</strong>
      </h3>
      <p className="shared-lead">
        Your viewers type <code>{role.command}</code>. {actionText(rules, role.action)} The shared
        goal is{' '}
        <strong>
          {rules.objective.kind === 'burst'
            ? `${rules.objective.target} bursts`
            : `${rules.objective.target} points`}
        </strong>{' '}
        in a {clock(rules.durationMs)} round, together with{' '}
        {others.map((r) => r.label).join(' and ')}.
      </p>
      <dl className="shared-facts">
        <div>
          <dt>Who can join</dt>
          <dd>
            {manifest.trigger.audience.includes('viewer')
              ? 'Everyone in your chat, for free'
              : manifest.trigger.audience.join(' or ')}
            . Your channel keeps its own roles.
          </dd>
        </div>
        <div>
          <dt>Per viewer</dt>
          <dd>
            {rules.resource.perParticipant} {rules.resource.name} each round
          </dd>
        </div>
        <div>
          <dt>Your overlay shows</dt>
          <dd>
            {role.fields.length
              ? role.fields.map((f) => fieldNames[f]).join(' · ')
              : 'Status and instructions only'}
          </dd>
        </div>
        <div>
          <dt>If you leave</dt>
          <dd>
            {role.required
              ? 'The shared round pauses. The host chooses to wait for you, continue without you, or end it.'
              : 'The other channels keep playing.'}
          </dd>
        </div>
        <div>
          <dt>Raid handoff</dt>
          <dd>
            {review.contract.raidHandoff
              ? 'On: if the host raids a channel in this round, that channel presents the rest. No credentials move.'
              : 'Off: raids never change who presents this round.'}
          </dd>
        </div>
      </dl>
      <ul className="shared-roster" aria-label="Channels in this agreement">
        {review.contract.roles.map((r) => (
          <li key={r.id} data-mine={r.id === role.id || undefined}>
            <strong>{r.label}</strong>
            <span>
              {r.id === role.id ? 'you' : `channel ${r.channelId}`} · <code>{r.command}</code> ·{' '}
              {r.action && r.action !== 'contribute' ? `${r.action} · ` : ''}
              {r.required ? 'required' : 'optional'}
            </span>
          </li>
        ))}
      </ul>
      <p className={`shared-verified ${review.verification.ok ? 'good' : 'bad'}`}>
        {review.verification.ok ? '✓' : '✗'} Riff re-tested this exact version on your machine:{' '}
        {passed}/{review.verification.stages.length} checks passed · {review.verification.generated}{' '}
        generated and {review.verification.host} host scenarios.
      </p>
      <div className="shared-preview" aria-label="Private shared experience preview">
        <p>{review.preview.label}</p>
        <ol>
          {review.preview.codes.map((code, i) => (
            <li key={i} data-tone={code === 'ACCEPTED' ? 'good' : 'warn'}>
              {outcome(code)}
            </li>
          ))}
        </ol>
        <p className="note">
          Sample score {review.preview.score}. Private test data; nothing was sent to any channel.
        </p>
      </div>
      <details>
        <summary>Checks, exact version and source</summary>
        <ul>
          {review.verification.stages.map((stage) => (
            <li key={stage.label}>
              {stage.label}: {stage.status}
            </li>
          ))}
        </ul>
        <p className="shared-digest">Agreement {review.contract.digest}</p>
        <p className="shared-digest">Artifact {review.contract.artifactId}</p>
        <pre>{review.contract.artifact.source}</pre>
      </details>
    </section>
  );
}

function LiveRound(props: {
  projection: SharedProjection;
  state: MemberState;
  reason: string | null;
}) {
  const { projection } = props;
  const round = ROUND_STATE[projection.status];
  return (
    <section className="shared-live" aria-label="Your shared round">
      <div className="shared-live-head">
        <div>
          <p className="shared-eyebrow">
            Your role · {projection.roleLabel}
            {projection.partners?.length ? ` · with ${projection.partners.join(', ')}` : ''}
          </p>
          <h3>{projection.title}</h3>
        </div>
        <span className={`pill ${props.state === 'paused' ? 'warn' : round.tone}`}>
          {props.state === 'paused' ? 'Coordinator unreachable' : round.text}
        </span>
      </div>
      <Progress projection={projection} />
      <p className="shared-stats">
        {projection.remaining !== undefined && projection.status !== 'finished' && (
          <span>{clock(projection.remaining)} left</span>
        )}
        {projection.contributions !== undefined && (
          <span>{projection.contributions} from your channel</span>
        )}
        {projection.bursts !== undefined && <span>{projection.bursts} bursts</span>}
        {projection.tier !== undefined && <span>Tier {projection.tier}</span>}
      </p>
      {projection.presenter && (
        <p className="note">
          {projection.presenter === projection.roleLabel
            ? 'After the raid, your channel presents the rest of this round.'
            : `After the raid, ${projection.presenter} presents the rest of this round.`}
        </p>
      )}
      {projection.status !== 'finished' && <p>{projection.instructions}</p>}
      {projection.status === 'finished' && (
        <p className="note">
          This round is over and its result stays on your overlay. Leave to clear it.
        </p>
      )}
      {(props.reason ?? projection.reason) && (
        <p className="note">{props.reason ?? projection.reason}</p>
      )}
    </section>
  );
}

export function CollaborationPanel({
  versions,
  panic,
}: {
  versions: readonly ShareableVersion[];
  panic: boolean;
}) {
  const [status, setStatus] = useState<CollaborationStatus | null>(null);
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [roles, setRoles] = useState<SharedRole[]>([roleDraft(0), roleDraft(1)]);
  const [invitation, setInvitation] = useState('');
  const [issued, setIssued] = useState<
    Record<string, { code: string; expiresAt: number; copied: boolean }>
  >({});
  const [consentFor, setConsentFor] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [another, setAnother] = useState(false);
  const [raidHandoff, setRaidHandoff] = useState(false);
  const opened = useRef(false);
  const epoch = useRef(0);
  const busy = useRef(false);
  const loading = useRef(false);
  const read = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (busy.current || loading.current) return;
    const fence = epoch.current;
    const controller = new AbortController();
    read.current = controller;
    loading.current = true;
    try {
      const next = await collaborationApi.status(controller.signal);
      if (!alive.current || fence !== epoch.current) return;
      setStatus(next);
      setFresh(true);
      const channelId = next.channelId;
      if (channelId)
        setRoles((current) =>
          current[0]?.channelId === channelId
            ? current
            : current.map((role, i) => (i === 0 ? { ...role, channelId } : role)),
        );
      // Open once automatically when something needs attention.
      if (
        !opened.current &&
        (next.member.state !== 'idle' || next.sessions.some((s) => s.status !== 'finished'))
      ) {
        opened.current = true;
        setOpen(true);
      }
    } catch (problem) {
      if (!alive.current || fence !== epoch.current || controller.signal.aborted) return;
      setFresh(false);
      setError(
        problem instanceof Error && problem.name !== 'ZodError'
          ? problem.message
          : 'Could not refresh shared channel status.',
      );
    } finally {
      if (read.current === controller) loading.current = false;
    }
  }, []);
  const active = !!status && ['connected', 'paused', 'review'].includes(status.member.state);
  // Poll quickly while open or sharing; otherwise only keep the summary roughly current.
  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => void load(), open || active ? 2000 : 10000);
    return () => {
      clearInterval(timer);
    };
  }, [load, open, active]);
  useEffect(
    () => () => {
      alive.current = false;
      epoch.current++;
      read.current?.abort();
      // An aborted read must not leave the next mount thinking a request is in flight.
      loading.current = false;
      mutation.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!Object.keys(issued).length) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [issued]);
  useEffect(() => {
    if (panic) {
      setConsentFor(null);
      setIssued({});
      setInvitation('');
      epoch.current++;
      read.current?.abort();
      mutation.current?.abort();
      busy.current = false;
      loading.current = false;
      setPending(null);
      void load();
    }
  }, [panic, load]);
  async function run(
    label: string,
    action: (signal: AbortSignal) => Promise<unknown>,
    force = false,
    done?: string,
  ) {
    if (busy.current && !force) return;
    const fence = ++epoch.current;
    read.current?.abort();
    loading.current = false;
    mutation.current?.abort();
    const controller = new AbortController();
    mutation.current = controller;
    busy.current = true;
    setPending(label);
    setError(null);
    setNotice(null);
    setConsentFor(null);
    try {
      await action(controller.signal);
      if (alive.current && fence === epoch.current && done) setNotice(done);
    } catch (problem) {
      if (alive.current && fence === epoch.current && !controller.signal.aborted)
        setError(
          problem instanceof Error && problem.name !== 'ZodError'
            ? problem.message
            : 'The response was invalid. Refresh and review again.',
        );
    } finally {
      if (alive.current && fence === epoch.current) {
        busy.current = false;
        setPending(null);
        await load();
      }
    }
  }
  const shareable = versions.filter(
    (v) =>
      v.evidence.verification.ok &&
      !['failed', 'discarded', 'quarantined'].includes(v.status) &&
      !!v.manifest.experience &&
      v.manifest.experience.version <= 2 &&
      v.manifest.experience.teams.length === 0 &&
      (v.manifest.experience.objective.kind === 'collective-goal' ||
        (v.manifest.experience.version === 2 &&
          v.manifest.experience.objective.kind === 'burst')) &&
      !(
        v.manifest.experience.version === 2 &&
        (v.manifest.experience.mechanics?.match || v.manifest.experience.mechanics?.health)
      ),
  );
  const versionId = shareable.some((v) => v.id === selected) ? selected : (shareable[0]?.id ?? '');
  const memberState = status?.member.state ?? 'idle';
  const activeMember = memberState === 'connected' || memberState === 'paused';
  const disabled = !!pending || panic || !fresh || !status?.configured;
  const review = memberState === 'review' ? status?.member.review : null;
  // Consent is bound to exactly what was reviewed. Any change to the agreement, role,
  // readiness or channel yields a different key, so earlier consent no longer matches.
  // Derived rather than reset in an effect: an effect could run after the creator ticks
  // the box and silently untick it.
  const reviewKey = review
    ? `${review.contract.digest}:${review.roleId}:${String(status?.ready)}:${status?.channelId ?? ''}`
    : null;
  const editRole = (index: number, patch: Partial<SharedRole>) =>
    setRoles((current) => current.map((role, i) => (i === index ? { ...role, ...patch } : role)));
  const actions = roleActions(shareable.find((v) => v.id === versionId)?.manifest.experience);
  const invalidRoles =
    !rolesSchema.safeParse(roles).success ||
    roles.some((r) => r.action && !actions.some((a) => a.value === r.action));
  const sessions = status?.sessions ?? [];
  const current = sessions.filter((s) => s.status !== 'finished');
  const past = sessions.filter((s) => s.status === 'finished');
  const projection = status?.member.projection ?? null;
  const summary = panic
    ? { text: 'Stopped', tone: 'bad' }
    : activeMember && projection
      ? {
          text: `${memberState === 'paused' ? 'Unreachable' : ROUND_STATE[projection.status].text}${
            projection.score !== undefined && projection.target !== undefined
              ? ` · ${projection.score}/${projection.target}`
              : ''
          }`,
          tone: memberState === 'paused' ? 'warn' : ROUND_STATE[projection.status].tone,
        }
      : memberState === 'review'
        ? { text: 'Invitation to review', tone: 'warn' }
        : current[0]
          ? ROUND_STATE[current[0].status]
          : { text: 'Not sharing', tone: 'muted' };
  const bodyId = 'shared-channels-body';
  return (
    <section className="card shared-panel" aria-label="Shared channels">
      <header className="shared-head">
        <button
          type="button"
          className="shared-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            opened.current = true;
            setOpen((v) => !v);
          }}
        >
          <span className="shared-title">Shared channels</span>
          <span className="shared-subtitle">Play one cooperative round with other streamers</span>
        </button>
        <span className={`pill ${summary.tone}`}>{summary.text}</span>
      </header>
      <section
        id={bodyId}
        className="shared-body"
        aria-label="Shared channels workspace"
        hidden={!open}
      >
        {error && (
          <p role="alert" className="answer bad">
            {error}
          </p>
        )}
        {pending && (
          <p role="status" className="note">
            {pending}…
          </p>
        )}
        {notice && !pending && (
          <p role="status" className="answer good">
            {notice}
          </p>
        )}
        {!status && <p className="note">Loading shared channel status…</p>}
        {status && (
          <>
            <ul className="shared-ready" aria-label="Before you start">
              <li data-ok={status.configured}>
                {status.configured
                  ? 'Secure storage ready'
                  : 'Configure RIFF_SECRET on this Riff instance before connecting channels.'}
              </li>
              <li data-ok={status.ready}>
                {status.ready && status.channelId ? (
                  <>
                    Twitch connected
                    {status.login ? ` as @${status.login}` : ''} · channel ID{' '}
                    <code>{status.channelId}</code>{' '}
                    <button
                      type="button"
                      className="button small ghost"
                      onClick={() => {
                        void copy(status.channelId ?? '').then((ok) =>
                          setNotice(
                            ok
                              ? 'Channel ID copied. Send it to the host.'
                              : `Your channel ID is ${status.channelId}.`,
                          ),
                        );
                      }}
                    >
                      Copy ID
                    </button>
                  </>
                ) : (
                  'Connect Twitch and wait for chat to be online before approving participation.'
                )}
              </li>
              {panic && (
                <li data-ok={false}>
                  Everything is stopped. Resume your channel before reviewing new participation.
                </li>
              )}
            </ul>

            {activeMember && projection && (
              <div className="shared-current">
                <LiveRound
                  projection={projection}
                  state={memberState}
                  reason={status.member.reason}
                />
              </div>
            )}
            {activeMember && !projection && (
              <p className="note">
                {MEMBER_STATE[memberState]} ·{' '}
                {status.member.reason ?? 'Waiting for the coordinator…'}
              </p>
            )}

            {review && (
              <div className="shared-current">
                <Review review={review} own={status.member.origin === 'local'} />
                <div className="shared-approval">
                  <label className="shared-check">
                    <input
                      type="checkbox"
                      checked={consentFor === reviewKey}
                      onChange={(e) => setConsentFor(e.target.checked ? reviewKey : null)}
                    />
                    I approve this exact version, my role, and the public fields shown above
                  </label>
                  <button
                    className="button go"
                    type="button"
                    disabled={
                      disabled ||
                      !status.ready ||
                      !review.verification.ok ||
                      consentFor !== reviewKey
                    }
                    onClick={() =>
                      void run(
                        'Approving membership',
                        (signal) => collaborationApi.approve(review.contract.digest, signal),
                        false,
                        'You joined the shared round. Your overlay shows it once the host starts.',
                      )
                    }
                  >
                    Approve my role and view
                  </button>
                </div>
              </div>
            )}

            {(memberState !== 'idle' || pending) && (
              <div className="shared-leave">
                <span className="note">
                  {MEMBER_STATE[memberState]}
                  {status.member.origin && status.member.origin !== 'local'
                    ? ` · host ${status.member.origin}`
                    : status.member.origin === 'local'
                      ? ' · hosted here'
                      : ''}
                  {memberState === 'stopped' && status.member.reason
                    ? ` · ${status.member.reason}`
                    : ''}
                </span>
                {status.member.canRecheck && memberState === 'stopped' && (
                  <button
                    className="button small ghost"
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      void run('Verifying saved membership', (signal) =>
                        collaborationApi.recheck(signal),
                      )
                    }
                  >
                    Verify saved membership again
                  </button>
                )}
                {memberState !== 'stopped' && (
                  <button
                    className="button small stop"
                    type="button"
                    onClick={() => {
                      setIssued({});
                      void run(
                        'Leaving shared experience',
                        (signal) => collaborationApi.leave(signal),
                        true,
                        'You left. Your overlay no longer shows the shared round.',
                      );
                    }}
                  >
                    {memberState === 'review' ? 'Decline' : 'Leave shared experience'}
                  </button>
                )}
              </div>
            )}

            {current.map((session) => (
              <HostedRound
                key={session.contract.id}
                session={session}
                channelId={status.channelId}
                disabled={disabled}
                activeMember={!!activeMember || memberState === 'review'}
                issued={issued}
                now={now}
                onReviewOwn={() =>
                  void run('Re-testing your role', (signal) =>
                    collaborationApi.ownerReview(session.contract.id, signal),
                  )
                }
                onInvite={(role) =>
                  void run('Creating invitation', async (signal) => {
                    const next = await collaborationApi.invite(
                      session.contract.id,
                      role.id,
                      signal,
                    );
                    if (!signal.aborted)
                      setIssued((all) => ({
                        ...all,
                        [`${session.contract.id}:${role.id}`]: {
                          code: inviteCode(next.origin, next.token),
                          expiresAt: next.expiresAt,
                          copied: false,
                        },
                      }));
                  })
                }
                onCopied={(key) =>
                  setIssued((all) =>
                    all[key] ? { ...all, [key]: { ...all[key], copied: true } } : all,
                  )
                }
                onHide={(key) =>
                  setIssued((all) =>
                    Object.fromEntries(Object.entries(all).filter(([k]) => k !== key)),
                  )
                }
                onControl={(action) =>
                  void run(
                    CONTROL_PENDING[action],
                    (signal) =>
                      collaborationApi.control(
                        session.contract.id,
                        session.revision,
                        action,
                        signal,
                      ),
                    false,
                    CONTROL_DONE[action],
                  )
                }
              />
            ))}

            {!activeMember && memberState !== 'review' && current.length > 0 && !another && (
              <button
                type="button"
                className="button small ghost shared-another"
                onClick={() => setAnother(true)}
              >
                Set up another round or join one
              </button>
            )}
            {!activeMember && memberState !== 'review' && (!current.length || another) && (
              <div className="shared-columns">
                <div className="shared-column">
                  <h3>Host a round</h3>
                  <p className="note">
                    Pick a tested cooperative goal, give each channel a role and command, then
                    invite them.
                  </p>
                  {!shareable.length && (
                    <p className="answer warn">
                      Sharing needs a teamless cooperative goal (like the Community Goal example)
                      that passed its tests. Describe and test one first.
                    </p>
                  )}
                  <label>
                    Verified cooperative version
                    <select
                      value={versionId}
                      onChange={(e) => setSelected(e.target.value)}
                      disabled={disabled || !shareable.length}
                    >
                      {/* Placeholder only: the first verified version is preselected. */}
                      <option value="" disabled>
                        Choose a version
                      </option>
                      {shareable.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.title} · v{v.number}
                        </option>
                      ))}
                    </select>
                  </label>
                  {roles.map((role, index) => {
                    const problem = roleProblem(roles, index);
                    return (
                      <fieldset
                        key={role.id}
                        className="shared-role"
                        disabled={disabled}
                        data-invalid={problem ? true : undefined}
                      >
                        <legend>
                          {index === 0 ? 'Your channel' : `Channel ${index + 1}`}
                          {role.required ? ' · required' : ' · optional'}
                        </legend>
                        <div className="shared-role-grid">
                          <label>
                            Role {index + 1} name
                            <input
                              maxLength={60}
                              value={role.label}
                              onChange={(e) => editRole(index, { label: e.target.value })}
                            />
                          </label>
                          <label>
                            Role {index + 1} command
                            <input
                              maxLength={33}
                              value={role.command}
                              onChange={(e) =>
                                editRole(index, { command: e.target.value.trim().toLowerCase() })
                              }
                            />
                          </label>
                          <label>
                            Role {index + 1} Twitch channel ID
                            <input
                              inputMode="numeric"
                              maxLength={32}
                              value={role.channelId}
                              readOnly={index === 0}
                              placeholder={index === 0 ? 'Connect Twitch' : 'e.g. 12826'}
                              onChange={(e) =>
                                editRole(index, { channelId: e.target.value.trim() })
                              }
                            />
                          </label>
                        </div>
                        <div className="shared-role-options">
                          <label className="shared-check">
                            <input
                              type="checkbox"
                              checked={role.required}
                              disabled={index === 0}
                              onChange={(e) => editRole(index, { required: e.target.checked })}
                            />
                            Required for shared play
                          </label>
                          {actions.length > 1 && (
                            <label>
                              Role {index + 1} action
                              <select
                                value={role.action ?? 'contribute'}
                                onChange={(e) => editRole(index, { action: e.target.value })}
                              >
                                {actions.map((a) => (
                                  <option key={a.value} value={a.value}>
                                    {a.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          <span className="note">Overlay shows:</span>
                          {publicFields.map((field) => (
                            <label className="shared-check" key={field}>
                              <input
                                type="checkbox"
                                checked={role.fields.includes(field)}
                                onChange={(e) =>
                                  editRole(index, {
                                    fields: e.target.checked
                                      ? [...role.fields, field]
                                      : role.fields.filter((f) => f !== field),
                                  })
                                }
                              />
                              {fieldNames[field]}
                            </label>
                          ))}
                        </div>
                        {problem && <p className="shared-problem">{problem}</p>}
                        {index >= 2 && (
                          <button
                            className="button small ghost"
                            type="button"
                            onClick={() => setRoles((all) => all.filter((r) => r.id !== role.id))}
                          >
                            Remove role {index + 1}
                          </button>
                        )}
                      </fieldset>
                    );
                  })}
                  <label className="shared-check">
                    <input
                      type="checkbox"
                      checked={raidHandoff}
                      disabled={disabled}
                      onChange={(e) => setRaidHandoff(e.target.checked)}
                    />
                    Allow raid handoff: if I raid a channel in this round, it presents the rest
                    (every channel approves this)
                  </label>
                  <div className="shared-actions">
                    <button
                      className="button small ghost"
                      type="button"
                      disabled={disabled || roles.length >= 4}
                      onClick={() =>
                        setRoles((all) => [
                          ...all,
                          roleDraft(Math.max(...all.map((r) => Number(r.id.split('-')[1])))),
                        ])
                      }
                    >
                      Add a channel
                    </button>
                    <button
                      className="button primary"
                      type="button"
                      disabled={disabled || !versionId || invalidRoles}
                      onClick={() =>
                        void run(
                          'Creating agreement',
                          (signal) =>
                            collaborationApi.create(versionId, roles, raidHandoff, signal),
                          false,
                          'Agreement created. Approve your own role, then invite the other channels.',
                        )
                      }
                    >
                      Create shared agreement
                    </button>
                  </div>
                </div>
                <div className="shared-column">
                  <h3>Join a round</h3>
                  <p className="note">
                    Paste the invitation the host sent you. Riff re-tests the exact version on this
                    machine and shows a private preview. Nothing joins or goes live until you
                    approve.
                  </p>
                  <label>
                    Private invitation
                    <textarea
                      rows={3}
                      value={invitation}
                      maxLength={1000}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="riff-invite:…"
                      onChange={(e) => setInvitation(e.target.value)}
                    />
                  </label>
                  <button
                    className="button"
                    type="button"
                    disabled={disabled || !invitation.trim()}
                    onClick={() =>
                      void run('Re-testing the invited version', async (signal) => {
                        const value = parseInvite(invitation);
                        if (!value)
                          throw new Error(
                            'That doesn’t look like a complete invitation. Copy the whole line starting with riff-invite: and paste it again.',
                          );
                        await collaborationApi.review(value.origin, value.token, signal);
                        setInvitation('');
                      })
                    }
                  >
                    Review invitation privately
                  </button>
                </div>
              </div>
            )}

            {past.length > 0 && (
              <details className="shared-past">
                <summary>Past rounds · {past.length}</summary>
                <ul>
                  {past.map((session) => (
                    <li key={session.contract.id}>
                      <strong>{session.contract.title}</strong> ·{' '}
                      {session.contract.roles.map((r) => r.label).join(' + ')} ·{' '}
                      {session.reason ?? 'Finished'}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>
    </section>
  );
}

/** One hosted agreement as a three-step checklist: approve yours, invite theirs, start. */
function HostedRound(props: {
  session: SharedView;
  channelId: string | null;
  disabled: boolean;
  activeMember: boolean;
  issued: Record<string, { code: string; expiresAt: number; copied: boolean }>;
  now: number;
  onReviewOwn: () => void;
  onInvite: (role: SharedRole) => void;
  onCopied: (key: string) => void;
  onHide: (key: string) => void;
  onControl: (action: SharedControl) => void;
}) {
  const { session } = props;
  const memberOf = (role: SharedRole) => session.members.find((m) => m.roleId === role.id);
  const mine = session.contract.roles.find((r) => r.channelId === props.channelId);
  const others = session.contract.roles.filter((r) => r !== mine);
  const ready = (r: SharedRole) => {
    const m = memberOf(r);
    return !!m?.approved && !!m.connected;
  };
  const mineReady = mine ? ready(mine) : false;
  const needed = session.contract.roles.filter(
    (r) => session.status === 'waiting' || (r.required && !memberOf(r)?.dropped),
  );
  const lost = session.contract.roles.filter((r) => session.lost.includes(r.id));
  const presenter = session.contract.roles.find((r) => memberOf(r)?.presenting);
  const missing = needed.filter((r) => !ready(r));
  const round = ROUND_STATE[session.status];
  const action =
    session.status === 'running' ? 'pause' : session.status === 'waiting' ? 'start' : 'resume';
  return (
    <article className="shared-hosted" aria-label={`Hosted round ${session.contract.title}`}>
      <header className="shared-live-head">
        <div>
          <p className="shared-eyebrow">You are hosting</p>
          <h3>{session.contract.title}</h3>
        </div>
        <span className={`pill ${round.tone}`}>{round.text}</span>
      </header>
      {session.reason && <p className="note">{session.reason}</p>}
      {presenter && (
        <p className="note">After your raid, {presenter.label} presents the rest of this round.</p>
      )}
      {lost.length > 0 && (
        <section className="shared-continuation" aria-label="Missing channel choice">
          <strong>
            {lost.map((r) => r.label).join(', ')} {lost.length > 1 ? 'are' : 'is'} missing. What
            should happen?
          </strong>
          {session.waitUntil !== null && (
            <p className="note">
              Waiting · {clock(session.waitUntil - props.now)} left. The round resumes on its own if
              they reconnect.
            </p>
          )}
          <div className="shared-actions">
            <button
              type="button"
              className="button small"
              disabled={props.disabled || session.waitUntil !== null}
              onClick={() => props.onControl('wait')}
            >
              Wait 2 minutes
            </button>
            <button
              type="button"
              className="button small"
              disabled={props.disabled}
              onClick={() => props.onControl('continue')}
            >
              Continue without {lost.map((r) => r.label).join(', ')}
            </button>
            <button
              type="button"
              className="button small stop"
              disabled={props.disabled}
              onClick={() => props.onControl('end')}
            >
              End and show results
            </button>
          </div>
        </section>
      )}
      <ol className="shared-steps">
        <li data-done={mineReady || undefined}>
          <div className="shared-step-head">
            <strong>Approve your own role</strong>
            {mine && (
              <span className="note">
                {mine.label} · <code>{mine.command}</code>
              </span>
            )}
          </div>
          {mineReady ? (
            <p className="note">Approved and connected.</p>
          ) : (
            !props.activeMember && (
              <button
                type="button"
                className="button small"
                disabled={props.disabled}
                onClick={props.onReviewOwn}
              >
                Review my role
              </button>
            )
          )}
        </li>
        <li data-done={others.every(ready) || undefined}>
          <div className="shared-step-head">
            <strong>Invite the other channels</strong>
            <span className="note">Each invitation works once and expires after 15 minutes.</span>
          </div>
          <ul className="shared-invites">
            {others.map((role) => {
              const member = memberOf(role);
              const key = `${session.contract.id}:${role.id}`;
              const invite = props.issued[key];
              const left = invite ? invite.expiresAt - props.now : 0;
              return (
                <li key={role.id}>
                  <div className="shared-invite-row">
                    <span>
                      <strong>{role.label}</strong>{' '}
                      <span className="note">
                        channel {role.channelId} · <code>{role.command}</code>
                        {role.required ? '' : ' · optional'}
                      </span>
                    </span>
                    <span
                      className={`badge ${member?.approved ? (member.connected ? 'good' : 'warn') : 'muted'}`}
                    >
                      {member?.approved
                        ? member.connected
                          ? 'Joined'
                          : 'Joined · offline'
                        : 'Not joined yet'}
                    </span>
                    {session.status !== 'finished' && (
                      <button
                        type="button"
                        className="button small ghost"
                        disabled={props.disabled}
                        aria-label={`${invite || member?.approved ? 'New invitation' : 'Create invitation'} for ${role.label}`}
                        onClick={() => props.onInvite(role)}
                      >
                        {invite || member?.approved ? 'New invitation' : 'Create invitation'}
                      </button>
                    )}
                  </div>
                  {invite && (
                    <div className="shared-invitation">
                      <label>
                        Invitation for {role.label}
                        <input readOnly value={invite.code} onFocus={(e) => e.target.select()} />
                      </label>
                      <div className="shared-actions">
                        <button
                          type="button"
                          className="button small primary"
                          onClick={() =>
                            void copy(invite.code).then((ok) => ok && props.onCopied(key))
                          }
                        >
                          {invite.copied ? 'Copied' : 'Copy invitation'}
                        </button>
                        <span className="note">
                          {left > 0
                            ? `Send it privately · expires in ${clock(left)}`
                            : 'Expired · create a new invitation'}
                          . A new invitation revokes this one.
                        </span>
                        <button
                          type="button"
                          className="button small ghost"
                          onClick={() => props.onHide(key)}
                        >
                          Hide
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </li>
        <li data-done={session.status === 'running' || undefined}>
          <div className="shared-step-head">
            <strong>
              {action === 'pause'
                ? 'Shared round is live'
                : action === 'start'
                  ? 'Start the round'
                  : 'Resume the round'}
            </strong>
          </div>
          <div className="shared-actions">
            <button
              type="button"
              className={`button ${action === 'pause' ? '' : 'go'}`}
              disabled={props.disabled || (action !== 'pause' && missing.length > 0)}
              onClick={() => props.onControl(action)}
            >
              {action === 'pause'
                ? 'Pause shared round'
                : action === 'start'
                  ? 'Start shared round'
                  : 'Resume shared round'}
            </button>
            {action !== 'pause' && missing.length > 0 && (
              <span className="note">
                Waiting for {missing.map((r) => r.label).join(', ')} to approve and connect.
              </span>
            )}
          </div>
        </li>
      </ol>
      {session.decisions.length > 0 && (
        <details className="shared-fingerprint">
          <summary>Host decisions · {session.decisions.length}</summary>
          <ul>
            {session.decisions.map((d, i) => (
              <li key={i}>
                {DECISION[d.code] ?? d.code} · {new Date(d.at).toLocaleTimeString()}
              </li>
            ))}
          </ul>
        </details>
      )}
      <details className="shared-fingerprint">
        <summary>Agreement fingerprint</summary>
        <p className="shared-digest">{session.contract.digest}</p>
      </details>
    </article>
  );
}
