import type {
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
 * Durable admission record for rolling-window interactions: every command decision,
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
