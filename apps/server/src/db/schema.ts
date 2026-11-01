import type { SharedContract, SharedMember } from '../services/collaboration/contract.js';
import type { SceneRevision } from '../services/scenes/contract.js';
import type {
  ScenarioRecord,
  RunRecord,
  RegressionRecord,
} from '../services/rehearsal/contract.js';
import type {
  DirectorState,
  RecipeState,
  RecipeProfile,
  ExperienceDefinition,
  SessionTransitionPlan,
  SessionSnapshot,
  ChatEvent,
  DecisionCode,
  ExecutionDecision,
} from '@riff/sdk';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

/** Channel-wide control state. Panic persists so a restart stays stopped. */
export const channelState = sqliteTable('channel_state', {
  channelId: text('channel_id')
    .primaryKey()
    .references(() => channels.id),
  panic: integer('panic', { mode: 'boolean' }).notNull().default(false),
  panicAt: integer('panic_at'),
  transitionEpoch: integer('transition_epoch').notNull().default(0),
  overlayKey: text('overlay_key').notNull(),
  twitchUserId: text('twitch_user_id'),
  twitchLogin: text('twitch_login'),
  /** AES-256-GCM sealed JSON {accessToken, refreshToken, expiresAt, scopes}. */
  twitchTokens: text('twitch_tokens'),
  updatedAt: integer('updated_at').notNull(),
});

export const automations = sqliteTable(
  'automations',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    title: text('title').notNull(),
    activeVersionId: text('active_version_id'),
    /** draft (never approved), live, paused. */
    status: text('status', { enum: ['draft', 'live', 'paused'] }).notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('automations_channel').on(table.channelId)],
);

export const versions = sqliteTable(
  'versions',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    automationId: text('automation_id')
      .notNull()
      .references(() => automations.id),
    number: integer('number').notNull(),
    parentVersionId: text('parent_version_id'),
    /** sha256 of artifact + host policy; approval binds to it. */
    artifactId: text('artifact_id'),
    title: text('title').notNull(),
    intent: text('intent').notNull(),
    source: text('source').notNull(),
    manifest: text('manifest', { mode: 'json' }).notNull(),
    tests: text('tests', { mode: 'json' }).notNull(),
    behavior: text('behavior', { mode: 'json' }).notNull(),
    assumptions: text('assumptions', { mode: 'json' }).notNull(),
    /** Verification report and intent checks exactly as produced by the host. */
    evidence: text('evidence', { mode: 'json' }).notNull(),
    origin: text('origin', { enum: ['codex', 'offline', 'manual', 'reference'] }).notNull(),
    compileRunId: text('compile_run_id'),
    status: text('status', {
      enum: ['candidate', 'failed', 'approved', 'active', 'superseded', 'quarantined', 'discarded'],
    }).notNull(),
    incident: text('incident'),
    approvedAt: integer('approved_at'),
    activatedAt: integer('activated_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('versions_channel').on(table.channelId),
    uniqueIndex('versions_automation_number').on(table.automationId, table.number),
  ],
);

export const compileRuns = sqliteTable(
  'compile_runs',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    automationId: text('automation_id'),
    baseVersionId: text('base_version_id'),
    intent: text('intent').notNull(),
    status: text('status').notNull(),
    transport: text('transport').notNull(),
    model: text('model'),
    promptVersion: text('prompt_version').notNull(),
    threadId: text('thread_id'),
    attempts: text('attempts', { mode: 'json' }).notNull(),
    usage: text('usage', { mode: 'json' }),
    durationMs: integer('duration_ms'),
    error: text('error'),
    versionId: text('version_id'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('compile_runs_channel').on(table.channelId)],
);

export const activity = sqliteTable(
  'activity',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    at: integer('at').notNull(),
    kind: text('kind', { enum: ['decision', 'incident', 'control', 'system'] }).notNull(),
    automationId: text('automation_id'),
    versionId: text('version_id'),
    eventId: text('event_id'),
    viewer: text('viewer'),
    code: text('code'),
    message: text('message').notNull(),
  },
  (table) => [index('activity_channel_at').on(table.channelId, table.at)],
);

/** Current durable round per automation; old journal identities survive reset. */
export const experienceSessions = sqliteTable(
  'experience_sessions',
  {
    automationId: text('automation_id')
      .primaryKey()
      .references(() => automations.id),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    id: text('id').notNull().unique(),
    versionId: text('version_id')
      .notNull()
      .references(() => versions.id),
    definition: text('definition', { mode: 'json' }).$type<ExperienceDefinition>().notNull(),
    snapshot: text('snapshot', { mode: 'json' }).$type<SessionSnapshot>().notNull(),
    revision: integer('revision').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('sessions_channel').on(table.channelId)],
);
export const sessionEvents = sqliteTable(
  'session_events',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id').notNull(),
    sessionId: text('session_id').notNull(),
    automationId: text('automation_id').notNull(),
    versionId: text('version_id').notNull(),
    eventId: text('event_id').notNull(),
    at: integer('at').notNull(),
    event: text('event', { mode: 'json' }).$type<ChatEvent>().notNull(),
    code: text('code').notNull(),
    revision: integer('revision').notNull(),
  },
  (table) => [
    uniqueIndex('session_event_identity').on(table.channelId, table.sessionId, table.eventId),
    uniqueIndex('session_automation_event_identity').on(
      table.channelId,
      table.automationId,
      table.eventId,
    ),
  ],
);
/**
 * Durable admission record for live interactions: every rolling command or stateful
 * cosmetic decision,
 * written before any effect leaves the host, so duplicate suppression, per-viewer
 * windows and effect budgets survive a restart. Rows older than the longest window
 * are pruned.
 */
export const admissionEvents = sqliteTable(
  'admission_events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    channelId: text('channel_id').notNull(),
    automationId: text('automation_id').notNull(),
    eventId: text('event_id').notNull(),
    viewerId: text('viewer_id').notNull(),
    at: integer('at').notNull(),
    code: text('code').$type<DecisionCode>().notNull(),
    effects: integer('effects').notNull(),
  },
  (table) => [
    uniqueIndex('admission_event_identity').on(table.channelId, table.automationId, table.eventId),
    index('admission_recent').on(table.channelId, table.at),
  ],
);
/**
 * Ordered round journal: every committed state change, written in the same
 * transaction, so an audit can rebuild the round from its inputs alone.
 */
export const sessionJournal = sqliteTable(
  'session_journal',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    channelId: text('channel_id').notNull(),
    sessionId: text('session_id').notNull(),
    automationId: text('automation_id').notNull(),
    versionId: text('version_id').notNull(),
    kind: text('kind', {
      enum: ['start', 'chat', 'pause', 'resume', 'advance', 'migration'],
    }).notNull(),
    at: integer('at').notNull(),
    event: text('event', { mode: 'json' }).$type<ChatEvent>(),
    code: text('code').$type<DecisionCode>(),
    snapshot: text('snapshot', { mode: 'json' }).$type<SessionSnapshot>(),
    definition: text('definition', { mode: 'json' }).$type<ExperienceDefinition>(),
    migration: text('migration', { mode: 'json' }).$type<{
      oldDefinition: ExperienceDefinition;
      newDefinition: ExperienceDefinition;
      source: string;
      sourceVersionId: string;
      plan: SessionTransitionPlan;
    }>(),
    digest: text('digest').notNull(),
  },
  (table) => [index('session_journal_order').on(table.channelId, table.sessionId, table.seq)],
);
export const sessionOutbox = sqliteTable(
  'session_outbox',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id').notNull(),
    sessionId: text('session_id').notNull(),
    automationId: text('automation_id').notNull(),
    versionId: text('version_id').notNull(),
    decision: text('decision', { mode: 'json' }).$type<ExecutionDecision>().notNull(),
    viewer: text('viewer'),
    at: integer('at').notNull(),
    dispatchedAt: integer('dispatched_at'),
  },
  (table) => [index('session_outbox_channel').on(table.channelId, table.automationId)],
);

/** Immutable reviewed artifacts and evidence; only status/timestamps can change. */
export const sessionTransitions = sqliteTable(
  'session_transitions',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    automationId: text('automation_id')
      .notNull()
      .references(() => automations.id),
    sourceVersionId: text('source_version_id')
      .notNull()
      .references(() => versions.id),
    targetVersionId: text('target_version_id')
      .notNull()
      .references(() => versions.id),
    sourceSessionId: text('source_session_id').notNull(),
    sourceRevision: integer('source_revision').notNull(),
    sourceDigest: text('source_digest').notNull(),
    epoch: integer('epoch').notNull(),
    migrationSource: text('migration_source').notNull(),
    plan: text('plan', { mode: 'json' }).$type<SessionTransitionPlan>().notNull(),
    evidence: text('evidence', { mode: 'json' }).notNull(),
    evidenceId: text('evidence_id').notNull(),
    status: text('status', { enum: ['review', 'pending', 'applied', 'cancelled'] }).notNull(),
    createdAt: integer('created_at').notNull(),
    approvedAt: integer('approved_at'),
    appliedAt: integer('applied_at'),
    cancelledAt: integer('cancelled_at'),
  },
  (table) => [index('transitions_channel_automation').on(table.channelId, table.automationId)],
);

/** Audience proposals are inert data; creator selections authorize separate authoring. */
export const proposals = sqliteTable(
  'proposals',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    text: text('text').notNull(),
    normalizedText: text('normalized_text').notNull(),
    /** Short channel-scoped number viewers and moderators can type in chat. */
    number: integer('number').notNull().default(0),
    state: text('state', { enum: ['pending', 'shortlisted', 'hidden', 'selected'] }).notNull(),
    revision: integer('revision').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('proposal_normalized').on(t.channelId, t.normalizedText),
    index('proposal_channel_state').on(t.channelId, t.state),
    uniqueIndex('proposal_number').on(t.channelId, t.number),
  ],
);
export const proposalContributors = sqliteTable(
  'proposal_contributors',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id').notNull(),
    proposalId: text('proposal_id')
      .notNull()
      .references(() => proposals.id),
    accountId: text('account_id').notNull(),
    displayName: text('display_name').notNull(),
    eventId: text('event_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('proposal_contributor_identity').on(t.channelId, t.proposalId, t.accountId)],
);
export const proposalHistory = sqliteTable(
  'proposal_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channelId: text('channel_id').notNull(),
    proposalId: text('proposal_id').notNull(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    revision: integer('revision').notNull(),
    at: integer('at').notNull(),
  },
  (t) => [index('proposal_history_channel').on(t.channelId, t.proposalId, t.id)],
);
export const proposalGrants = sqliteTable(
  'proposal_grants',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id').notNull(),
    accountId: text('account_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('proposal_grant_identity').on(t.channelId, t.accountId)],
);
export const proposalCredit = sqliteTable(
  'proposal_credit',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id').notNull(),
    accountId: text('account_id').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('proposal_credit_identity').on(t.channelId, t.accountId)],
);
/** Receipts also retain all suggestion attempts, including invalid/limited/grouped. */
export const proposalReceipts = sqliteTable(
  'proposal_receipts',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id').notNull(),
    eventId: text('event_id').notNull(),
    accountId: text('account_id').notNull(),
    kind: text('kind').notNull(),
    text: text('text'),
    proposalId: text('proposal_id'),
    result: text('result', { mode: 'json' }).notNull(),
    at: integer('at').notNull(),
  },
  (t) => [
    uniqueIndex('proposal_receipt_identity').on(t.channelId, t.eventId),
    index('proposal_receipt_recent').on(t.channelId, t.kind, t.at),
  ],
);
export const proposalBallots = sqliteTable(
  'proposal_ballots',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id').notNull(),
    /** Short channel-scoped number viewers type in `!riff vote <number> <option>`. */
    number: integer('number').notNull().default(0),
    revision: integer('revision').notNull(),
    createdAt: integer('created_at').notNull(),
    deadlineAt: integer('deadline_at').notNull(),
    closedAt: integer('closed_at'),
  },
  (t) => [
    index('proposal_ballot_channel').on(t.channelId, t.createdAt),
    uniqueIndex('proposal_ballot_number').on(t.channelId, t.number),
  ],
);
export const proposalBallotOptions = sqliteTable(
  'proposal_ballot_options',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id').notNull(),
    ballotId: text('ballot_id')
      .notNull()
      .references(() => proposalBallots.id),
    proposalId: text('proposal_id')
      .notNull()
      .references(() => proposals.id),
    option: integer('option').notNull(),
  },
  (t) => [uniqueIndex('proposal_ballot_option').on(t.channelId, t.ballotId, t.option)],
);
export const proposalVotes = sqliteTable(
  'proposal_votes',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id').notNull(),
    ballotId: text('ballot_id')
      .notNull()
      .references(() => proposalBallots.id),
    accountId: text('account_id').notNull(),
    option: integer('option').notNull(),
    eventId: text('event_id').notNull(),
    at: integer('at').notNull(),
  },
  (t) => [
    uniqueIndex('proposal_vote_identity').on(t.channelId, t.ballotId, t.accountId),
    index('proposal_votes_ballot').on(t.channelId, t.ballotId, t.option),
  ],
);
/** Immutable reviewed input plus an irreversible revocation marker. */
export const proposalSelections = sqliteTable(
  'proposal_selections',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id').notNull(),
    proposalId: text('proposal_id')
      .notNull()
      .references(() => proposals.id),
    proposalRevision: integer('proposal_revision').notNull(),
    brief: text('brief').notNull(),
    baseVersionId: text('base_version_id'),
    createdAt: integer('created_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [index('proposal_selection_channel').on(t.channelId, t.proposalId)],
);

/** Immutable claim: a selected audience brief can spend compiler quota only once. */
export const proposalGenerationRuns = sqliteTable(
  'proposal_generation_runs',
  {
    selectionId: text('selection_id')
      .primaryKey()
      .references(() => proposalSelections.id),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    runId: text('run_id')
      .notNull()
      .references(() => compileRuns.id),
  },
  (table) => [uniqueIndex('proposal_generation_run_identity').on(table.channelId, table.runId)],
);

/** Private immutable replay evidence. No foreign keys to deletable scenario/run history. */
export const rehearsalScenarios = sqliteTable(
  'rehearsal_scenarios',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    name: text('name').notNull(),
    revision: integer('revision').notNull(),
    scenario: text('scenario', { mode: 'json' }).$type<ScenarioRecord['scenario']>().notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('rehearsal_scenarios_channel').on(t.channelId)],
);
export const rehearsalRuns = sqliteTable(
  'rehearsal_runs',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    evidence: text('evidence', { mode: 'json' }).$type<RunRecord>().notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('rehearsal_runs_channel').on(t.channelId, t.createdAt)],
);
export const rehearsalRegressions = sqliteTable(
  'rehearsal_regressions',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    automationId: text('automation_id').notNull(),
    evidence: text('evidence', { mode: 'json' }).$type<RegressionRecord>().notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('rehearsal_regressions_channel').on(t.channelId, t.automationId)],
);

/** Scene heads use CAS; presentation revisions remain immutable audit evidence. */
export const sceneHeads = sqliteTable(
  'scene_heads',
  {
    versionId: text('version_id')
      .primaryKey()
      .references(() => versions.id),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    artifactId: text('artifact_id').notNull(),
    revision: integer('revision').notNull(),
    appliedRevision: integer('applied_revision'),
  },
  (t) => [index('scene_heads_channel').on(t.channelId)],
);
export const sceneRevisions = sqliteTable(
  'scene_revisions',
  {
    id: text('id').primaryKey(),
    versionId: text('version_id')
      .notNull()
      .references(() => versions.id),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    revision: integer('revision').notNull(),
    evidence: text('evidence', { mode: 'json' }).$type<SceneRevision>().notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('scene_revision_identity').on(t.channelId, t.versionId, t.revision)],
);

/** One coordinator owns each shared runtime; private snapshots never cross its boundary. */
export const collaborationSessions = sqliteTable(
  'collaboration_sessions',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    contract: text('contract', { mode: 'json' }).$type<SharedContract>().notNull(),
    snapshot: text('snapshot', { mode: 'json' }).$type<SessionSnapshot>().notNull(),
    members: text('members', { mode: 'json' }).$type<SharedMember[]>().notNull(),
    contributions: text('contributions', { mode: 'json' })
      .$type<Record<string, number>>()
      .notNull(),
    status: text('status', { enum: ['waiting', 'running', 'paused', 'finished'] }).notNull(),
    reason: text('reason'),
    revision: integer('revision').notNull(),
    started: integer('started', { mode: 'boolean' }).notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('collaboration_sessions_channel').on(table.channelId)],
);
export const collaborationReceipts = sqliteTable(
  'collaboration_receipts',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    sessionId: text('session_id')
      .notNull()
      .references(() => collaborationSessions.id),
    eventId: text('event_id').notNull(),
    code: text('code').notNull(),
    at: integer('at').notNull(),
  },
  (table) => [
    uniqueIndex('collaboration_receipt_identity').on(table.sessionId, table.eventId),
    index('collaboration_receipts_channel').on(table.channelId),
  ],
);
/** Local member connection credentials are AES-GCM sealed, never public state. */
export const collaborationConnections = sqliteTable('collaboration_connections', {
  channelId: text('channel_id')
    .primaryKey()
    .references(() => channels.id),
  sealed: text('sealed').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Durable, channel-scoped director review and control state; never pending cosmetics. */
export const directorState = sqliteTable('director_state', {
  channelId: text('channel_id').primaryKey(),
  value: text('value', { mode: 'json' }).$type<Omit<DirectorState, 'telemetry'>>().notNull(),
  batches: text('batches', { mode: 'json' }).$type<number[]>().notNull().default([]),
});

/** Portable recipe state; private imports/reviews remain channel-scoped. */
export const recipeState = sqliteTable('recipe_state', {
  channelId: text('channel_id')
    .primaryKey()
    .references(() => channels.id),
  value: text('value', { mode: 'json' })
    .$type<
      RecipeState & {
        exports: string[];
        installations: Record<
          string,
          {
            versionId: string;
            automationId: string;
            sourceDigest: string;
            profile: RecipeProfile;
          }
        >;
        rateKeys: Record<string, number[]>;
      }
    >()
    .notNull(),
});

/** Private host production grants and sealed connector configuration. */
export const productionState = sqliteTable('production_state', {
  channelId: text('channel_id')
    .primaryKey()
    .references(() => channels.id),
  value: text('value', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
});
/** Durable broadcast accessibility choices and bounded help receipts. */
export const participationState = sqliteTable('participation_state', {
  channelId: text('channel_id')
    .primaryKey()
    .references(() => channels.id),
  value: text('value', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
});

/**
 * F22: Channel Points rewards Riff created on Twitch (Twitch lets only the creating
 * client manage them) and their host-owned link to one automation plus refund policy.
 */
export const channelPointRewards = sqliteTable(
  'channel_point_rewards',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    rewardId: text('reward_id').notNull(),
    broadcasterId: text('broadcaster_id').notNull(),
    title: text('title').notNull(),
    cost: integer('cost').notNull(),
    prompt: text('prompt').notNull().default(''),
    inputRequired: integer('input_required', { mode: 'boolean' }).notNull().default(false),
    cooldownSeconds: integer('cooldown_seconds'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
    automationId: text('automation_id'),
    /** `auto`: fulfil accepted, refund refused. `manual`: accepted ones wait for the creator. */
    policy: text('policy').$type<'auto' | 'manual'>().notNull().default('auto'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('channel_point_reward_identity').on(table.channelId, table.rewardId),
    uniqueIndex('channel_point_reward_automation').on(table.channelId, table.automationId),
  ],
);
/** Durable redemption ledger: the redemption id is the dedupe identity across redeliveries. */
export const channelPointRedemptions = sqliteTable(
  'channel_point_redemptions',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    redemptionId: text('redemption_id').notNull(),
    rewardId: text('reward_id').notNull(),
    automationId: text('automation_id'),
    viewerId: text('viewer_id').notNull(),
    viewerName: text('viewer_name').notNull(),
    input: text('input').notNull().default(''),
    redeemedAt: text('redeemed_at').notNull(),
    receivedAt: integer('received_at').notNull(),
    /** queued, then fulfilled or refunded; failed when Twitch refused the status update. */
    status: text('status').$type<'queued' | 'fulfilled' | 'refunded' | 'failed'>().notNull(),
    code: text('code'),
    reason: text('reason').notNull().default(''),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('channel_point_redemption_identity').on(table.channelId, table.redemptionId),
    index('channel_point_redemptions_recent').on(table.channelId, table.receivedAt),
  ],
);
/** Prediction proposals from automations or the console; settlement stays creator-only. */
export const predictionRequests = sqliteTable(
  'prediction_requests',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    source: text('source').$type<'automation' | 'console'>().notNull(),
    automationId: text('automation_id'),
    versionId: text('version_id'),
    eventId: text('event_id'),
    title: text('title').notNull(),
    outcomes: text('outcomes', { mode: 'json' }).$type<string[]>().notNull(),
    windowSeconds: integer('window_seconds').notNull(),
    status: text('status').$type<'proposed' | 'dismissed' | 'opened' | 'failed'>().notNull(),
    predictionId: text('prediction_id'),
    message: text('message').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('prediction_requests_channel').on(table.channelId, table.createdAt),
    uniqueIndex('prediction_request_event').on(table.channelId, table.automationId, table.eventId),
  ],
);
