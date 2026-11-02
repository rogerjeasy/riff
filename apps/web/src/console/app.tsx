import { ChatAuthoringPanel, useChatAuthoring } from './chat-authoring/panel.js';
import { ProductionPanel } from './production/panel.js';
import { ChannelPointsPanel } from './channel-points/channel-points-panel.js';
import { PredictionsPanel } from './channel-points/predictions-panel.js';
import { ParticipationPanel } from './participation/panel.js';
import { InsightsPanel } from './insights/panel.js';
import { TwitchFeaturesPanel } from './twitch-features/panel.js';
import { TwitchEventsPanel } from './twitch/event-triggers.js';
import { RecipeLibrary } from './recipes/library.js';
import { RecipeInstall } from './recipes/install.js';
import { parseInstallLink, type InstallLink } from './recipes/install-link.js';
import { DirectorPanel } from './director/panel.js';
import { CollaborationPanel } from './collaboration/panel.js';
import { CanvasEditor } from './canvas/editor.js';
import { SignIn } from './sign-in.js';
import { type Scene } from '../scenes/schema.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { useStudio } from '../lib/use-studio.js';
import type { Run, Studio, Version } from '../lib/types.js';
import { ProposalInbox } from './proposals/inbox.js';
import { Composer } from './authoring/composer.js';
import { Evidence } from './review/evidence.js';
import { Rehearsal } from './rehearsal/stage.js';
import { ActivityFeed, LivePanel } from './live/live-panel.js';
import { triggerSummary } from './format.js';

interface Toast {
  id: number;
  message: string;
  kind: 'good' | 'bad';
}

export function StopControl({
  studio,
  notify,
  compact = false,
}: {
  studio: Studio;
  notify: (m: string, k?: 'good' | 'bad') => void;
  compact?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!studio.panic)
    return (
      <button
        type="button"
        className={`button stop${compact ? ' wide' : ''}`}
        onClick={() =>
          void api.panic().then(
            () => notify('Everything stopped. The overlay was cleared.', 'bad'),
            () =>
              notify(
                'Could not reach the server to stop. Close the OBS source as a fallback.',
                'bad',
              ),
          )
        }
      >
        <span aria-hidden="true">■</span> Stop everything
      </button>
    );
  return confirming ? (
    <span className="resume-confirm" role="group" aria-label="Confirm resume">
      <span>Resume eligible approved interactions? Removed proposal versions stay paused.</span>
      <button
        type="button"
        className="button small go"
        onClick={() =>
          void api.resume().then(() => {
            setConfirming(false);
            notify('Channel resumed.');
          })
        }
      >
        Resume
      </button>
      <button type="button" className="button small ghost" onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </span>
  ) : (
    <button
      type="button"
      className={`button resume${compact ? ' wide' : ''}`}
      onClick={() => setConfirming(true)}
    >
      Stopped · Resume…
    </button>
  );
}

function Steps({
  version,
  previewed,
  studio,
}: {
  version: Version | null;
  previewed: boolean;
  studio: Studio;
}) {
  const automation = studio.automations.find((a) => a.id === version?.automationId);
  const live = version?.status === 'active' && automation?.status === 'live' && !studio.panic;
  const played =
    live && studio.activity.some((a) => a.kind === 'decision' && a.versionId === version?.id);
  const states = [
    version ? 'done' : 'current',
    !version ? 'todo' : version.evidence.verification.ok ? 'done' : 'failed',
    !version?.evidence.verification.ok
      ? 'todo'
      : previewed || version.status === 'active'
        ? 'done'
        : 'current',
    !version?.evidence.verification.ok
      ? 'todo'
      : version.status === 'active'
        ? 'done'
        : previewed
          ? 'current'
          : 'todo',
    played ? 'done' : live ? 'current' : 'todo',
  ];
  return (
    <ol className="steps" aria-label="Workflow">
      {['Describe', 'Test', 'Preview', 'Approve', 'Play'].map((label, i) => (
        <li key={label} data-state={states[i]}>
          <span className="step-num" aria-hidden="true">
            {states[i] === 'done' ? '✓' : states[i] === 'failed' ? '!' : i + 1}
          </span>
          {label}
          <span className="sr-only"> — {states[i]}</span>
        </li>
      ))}
    </ol>
  );
}

export function App() {
  const { studio, runs, connection, error, signedOut, refresh, setRuns } = useStudio();
  const chatAuthoring = useChatAuthoring(studio);
  // Hosted instances require a console session; show "Sign out" only where it means something.
  const [sessionRequired, setSessionRequired] = useState(false);
  useEffect(() => {
    void api.session().then(
      (session) => setSessionRequired(session.required),
      () => undefined,
    );
  }, []);
  const [sceneDraft, setSceneDraft] = useState<{
    versionId: string;
    scene: Scene;
    instructions: string[];
  } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [previewed, setPreviewed] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [draft, setDraft] = useState(
    'Let viewers throw tomatoes with !tomato, limited to three throws per person in any rolling 60 seconds.',
  );
  // F27: `/recipes/install?...` opens the guided install inside the signed-in console.
  const [installLink, setInstallLink] = useState<InstallLink | null>(() =>
    location.pathname === '/recipes/install' ? parseInstallLink(location) : null,
  );
  const [libraryEpoch, setLibraryEpoch] = useState(0);
  const notify = useCallback((message: string, kind: 'good' | 'bad' = 'good') => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-2), { id, message, kind }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 5000);
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('twitch') === 'connected') {
      notify(`Twitch connected as @${params.get('login') ?? 'you'}.`);
      history.replaceState(null, '', '/');
    }
  }, [notify]);

  const allVersions = useMemo(() => studio?.automations.flatMap((a) => a.versions) ?? [], [studio]);
  const run: Run | null = runId ? (runs[runId] ?? null) : null;
  // Push updates drive the UI; polling is a fallback so a run never looks stuck if the
  // socket is blocked by a proxy or reconnecting.
  useEffect(() => {
    if (!run || run.result) return;
    const timer = setInterval(() => void refresh(), connection === 'online' ? 3000 : 1000);
    return () => clearInterval(timer);
  }, [run, connection, refresh]);
  // Follow a finished generation to its candidate.
  useEffect(() => {
    if (run?.result?.versionId) setSelectedId(run.result.versionId);
  }, [run?.result?.versionId]);
  const selected =
    allVersions.find((v) => v.id === selectedId) ??
    allVersions.find((v) => v.status === 'candidate') ??
    allVersions.find((v) => v.status === 'active') ??
    null;
  const automation = studio?.automations.find((a) => a.id === selected?.automationId);
  const onScene = useCallback(
    (scene: Scene, instructions: string[]) => {
      if (selected) setSceneDraft({ versionId: selected.id, scene, instructions });
    },
    [selected?.id],
  );
  const editing =
    automation?.versions.find((v) => v.id === automation.activeVersionId) ??
    (selected?.status === 'candidate' ? null : selected);

  if (signedOut && !studio) return <SignIn />;
  if (!studio)
    return (
      <main className="boot">
        <span className="brand">
          riff<span>.</span>
        </span>
        <p role="status">{error ?? 'Connecting to your studio…'}</p>
      </main>
    );
  const liveCount = studio.automations.filter((a) => a.status === 'live').length;
  const twitchState = studio.twitch.state;

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <span className="brand">
          riff<span aria-hidden="true">.</span>
        </span>
        <nav className="status-row" aria-label="Connections">
          <span
            className={`pill ${studio.compiler.kind === 'codex' ? 'codex' : 'muted'}`}
            title="Runtime compiler"
          >
            {studio.compiler.kind === 'codex'
              ? `Codex${studio.compiler.model ? ` · ${studio.compiler.model}` : ''}`
              : 'Offline compiler'}
          </span>
          {studio.twitch.configured &&
          (twitchState === 'disconnected' || twitchState === 'error') ? (
            // A disconnected but configured channel is one click from connected.
            <a className="pill twitch-connect" href="/auth/twitch">
              Connect Twitch →
            </a>
          ) : (
            <span
              className={`pill ${twitchState === 'connected' ? 'good' : twitchState === 'error' ? 'bad' : 'muted'}`}
            >
              Twitch ·{' '}
              {twitchState === 'connected' && 'login' in studio.twitch
                ? `@${studio.twitch.login}`
                : twitchState}
            </span>
          )}
          <span className={`pill ${studio.overlay.connections ? 'good' : 'muted'}`}>
            Overlay · {studio.overlay.connections || 'none'}
          </span>
          <span
            className={`pill ${studio.panic ? 'bad' : liveCount ? 'live' : 'muted'}`}
            role="status"
          >
            {studio.panic ? 'Stopped' : liveCount ? `● Live · ${liveCount}` : 'Nothing live'}
          </span>
          {connection === 'offline' && (
            <span className="pill bad" role="alert">
              Server unreachable — reconnecting
            </span>
          )}
        </nav>
        {sessionRequired && (
          <button
            type="button"
            className="button small ghost sign-out"
            onClick={() => void api.logout().finally(() => location.reload())}
          >
            Sign out
          </button>
        )}
        <StopControl studio={studio} notify={notify} />
      </header>
      {studio.panic && (
        <div className="banner" role="alert">
          Everything is stopped
          {studio.panicAt ? ` since ${new Date(studio.panicAt).toLocaleTimeString()}` : ''}.
          Interaction commands are ignored. Proposals remain private and the overlay is clear until
          you resume.
        </div>
      )}
      <main id="main" className="studio">
        {installLink && (
          <RecipeInstall
            link={installLink}
            onClose={() => {
              history.replaceState(null, '', '/');
              setInstallLink(null);
            }}
            onInstalled={() => {
              setLibraryEpoch((n) => n + 1);
              void refresh();
            }}
            onReview={(id) => {
              history.replaceState(null, '', '/');
              setInstallLink(null);
              void refresh();
              setSelectedId(id);
              document
                .getElementById('describe-heading')
                ?.scrollIntoView({ behavior: 'instant', block: 'start' });
            }}
          />
        )}
        <div className="intro">
          <h1>Describe it. Test it. Watch chat play it.</h1>
          <p>
            Riff turns one sentence into a sandboxed, rate-limited Twitch interaction, proves it
            works, and only goes live when you approve that exact version.
          </p>
          <Steps
            version={selected}
            previewed={selected ? previewed.has(selected.id) : false}
            studio={studio}
          />
        </div>
        <ProposalInbox
          studio={studio}
          runs={runs}
          refresh={refresh}
          onRun={(started) => {
            setRuns((current) => ({ ...current, [started.id]: started }));
            setRunId(started.id);
          }}
          onReview={(id) => {
            setSelectedId(id);
            document
              .getElementById('describe-heading')
              ?.scrollIntoView({ behavior: 'instant', block: 'start' });
          }}
        />
        <ChatAuthoringPanel
          state={chatAuthoring}
          panic={studio.panic}
          notify={notify}
          onReview={(id) => {
            setSelectedId(id);
            document
              .getElementById('describe-heading')
              ?.scrollIntoView({ behavior: 'instant', block: 'start' });
          }}
        />
        <CollaborationPanel versions={allVersions} panic={studio.panic} />
        <DirectorPanel versions={allVersions} panic={studio.panic} />
        <ParticipationPanel />
        <InsightsPanel />
        <TwitchFeaturesPanel panic={studio.panic} />
        <TwitchEventsPanel studio={studio} />
        <ProductionPanel
          versions={allVersions}
          panic={studio.panic}
          onDraftIntent={(text) => {
            setDraft(text);
            document.getElementById('intent')?.focus();
          }}
        />
        <ChannelPointsPanel />
        <PredictionsPanel />
        <RecipeLibrary
          key={libraryEpoch}
          versions={allVersions}
          onReview={(id) => {
            void refresh();
            setSelectedId(id);
          }}
        />
        <div className="workspace">
          <div className="col">
            <Composer
              editing={editing ?? null}
              run={run}
              compiler={studio.compiler}
              draft={draft}
              setDraft={setDraft}
              onOpenVersion={setSelectedId}
              onCancel={(id) => void api.cancel(id).catch(() => undefined)}
              onGenerate={async (intent, baseVersionId) => {
                try {
                  const started = await api.generate(intent, baseVersionId);
                  setRuns((current) => ({ ...current, [started.id]: started }));
                  setRunId(started.id);
                } catch (cause) {
                  notify(
                    cause instanceof ApiError ? cause.message : 'Could not start generation.',
                    'bad',
                  );
                }
              }}
            />
            {selected ? (
              <Evidence
                key={selected.id}
                version={selected}
                automation={automation}
                panic={studio.panic}
                previewed={previewed.has(selected.id)}
                fromChat={
                  chatAuthoring.data?.candidates.some((c) => c.versionId === selected.id) ?? false
                }
                onTransitioned={async (message) => {
                  await refresh();
                  notify(message);
                }}
                onApprove={async (version, resetSession) => {
                  try {
                    await api.approve(version, automation?.activeVersionId ?? null, resetSession);
                    notify(
                      version.manifest.trigger.kind === 'twitch.event' ||
                        version.manifest.trigger.kind === 'points.redeem'
                        ? `Live! ${triggerSummary(version.manifest)} now triggers it.`
                        : `Live! Viewers can now type ${version.manifest.trigger.command}.`,
                    );
                    await refresh();
                  } catch (cause) {
                    notify(cause instanceof ApiError ? cause.message : 'Approval failed.', 'bad');
                    await refresh();
                  }
                }}
                onDiscard={async (version) => {
                  await api.discard(version.id).catch(() => undefined);
                  setSelectedId(null);
                  await refresh();
                }}
              />
            ) : (
              <section className="card empty-evidence">
                <p className="step-label">
                  <span>2</span> Test · evidence
                </p>
                <p>
                  Evidence appears here: what you asked vs. what will run, the generated tests,
                  Riff’s own checks and the exact code.
                </p>
              </section>
            )}
          </div>
          <div className="col">
            <Rehearsal
              instructions={
                sceneDraft?.versionId === selected?.id ? sceneDraft?.instructions : undefined
              }
              scene={sceneDraft?.versionId === selected?.id ? sceneDraft?.scene : undefined}
              version={selected && selected.evidence.verification.artifactId ? selected : null}
              onPreviewed={(id) =>
                setPreviewed((set) => (set.has(id) ? set : new Set(set).add(id)))
              }
              versions={allVersions}
              recording={
                automation?.session && automation.activeVersionId
                  ? { versionId: automation.activeVersionId, sessionId: automation.session.id }
                  : null
              }
              onRun={(started) => {
                setRuns((current) => ({ ...current, [started.id]: started }));
                setRunId(started.id);
              }}
            />
            {selected?.artifactId && (
              <CanvasEditor
                key={selected.id}
                version={selected}
                panic={studio.panic}
                compiler={studio.compiler.kind}
                onScene={onScene}
                onBehaviorEdit={() => document.getElementById('intent')?.focus()}
              />
            )}
            <LivePanel
              studio={studio}
              selectedVersionId={selected?.id ?? null}
              onSelect={(v) => setSelectedId(v.id)}
              onEdit={(v) => {
                setSelectedId(v.id);
                setDraft(
                  v.manifest.experience
                    ? 'Change the command to !splat, keep everyone’s teams and scores, and give each player two additional throws.'
                    : 'Change the command to !splat, allow two throws per 30 seconds, subscribers only.',
                );
                document.getElementById('intent')?.focus();
              }}
              notify={notify}
            />
            <ActivityFeed
              activity={studio.activity}
              selectedVersionId={selected?.id ?? null}
              onSelectVersion={(id) => setSelectedId(id)}
            />
          </div>
        </div>
      </main>
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <p key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </p>
        ))}
      </div>
    </>
  );
}
