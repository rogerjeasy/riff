import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { manifestSchema } from '@riff/sandbox';
import type {
  ParticipationLanguage,
  ParticipationSettings,
  ParticipationView,
  RecipePresentation,
  RecipePackage,
} from '@riff/sdk';
import type { DatabaseConnection } from '../../db/client.js';
import { participationState } from '../../db/schema.js';
import type { ChannelRepository } from '../../db/repositories/studio.js';
import type { LiveChatMessage } from '../live/runtime.js';
import { copy, phaseCopy, ruleCopy } from './copy.js';
export const languageSchema = z.enum(['en', 'fr', 'es', 'de']);
export const settingsSchema = z
  .object({
    language: z.enum(['inherit', 'en', 'fr', 'es', 'de']),
    reducedMotion: z.boolean(),
    highContrast: z.boolean(),
    effectLabels: z.boolean(),
  })
  .strict();
const recordSchema = z.object({
  settings: settingsSchema.extend({ revision: z.number().int().nonnegative() }),
  viewers: z.record(z.string(), z.number()),
  events: z.record(z.string(), z.number()),
  responses: z.array(z.number()),
});
const defaults: ParticipationSettings = {
  revision: 0,
  language: 'inherit',
  reducedMotion: false,
  highContrast: false,
  effectLabels: false,
};
export class ParticipationError extends Error {}
/** How long an accepted `!riff help` highlights on-stream guidance. */
export const HELP_MS = 15000;
/** Public guidance is recomputed at most this often while studio state is unchanged. */
export const VIEW_CACHE_MS = 1000;
/** A recipe's reviewed presentation plus the recipient channel name it is prefixed with. */
export type InstalledPresentation = RecipePresentation & { displayName?: string | undefined };
export function createParticipationService(deps: {
  database: DatabaseConnection;
  repo: ChannelRepository;
  blocked: () => boolean;
  changed: () => void;
  now?: () => number;
}) {
  const { database, repo } = deps,
    now = deps.now ?? Date.now;
  let closed = false,
    temporary: { language: ParticipationLanguage; until: number } | null = null,
    helpUntil = 0,
    timer: ReturnType<typeof setTimeout> | undefined;
  const cache = new Map<string, { at: number; stamp: string; view: ParticipationView }>();
  const read = () => {
    const value = database.db
      .select()
      .from(participationState)
      .where(eq(participationState.channelId, repo.channelId))
      .get()?.value;
    return value
      ? recordSchema.parse(value)
      : { settings: { ...defaults }, viewers: {}, events: {}, responses: [] };
  };
  function write(record: z.infer<typeof recordSchema>) {
    database.db
      .insert(participationState)
      .values({ channelId: repo.channelId, value: record })
      .onConflictDoUpdate({ target: participationState.channelId, set: { value: record } })
      .run();
  }
  const settings = () => read().settings;
  /** Cheap fingerprint of everything the public view reads besides the clock. */
  function stamp(language: ParticipationLanguage | undefined) {
    return JSON.stringify([
      language ?? null,
      settings().revision,
      deps.blocked(),
      repo.automations().map((a) => {
        const snapshot = repo.session(a.id)?.snapshot;
        return [
          a.id,
          a.status,
          a.activeVersionId,
          a.updatedAt,
          snapshot?.revision,
          snapshot?.phase,
        ];
      }),
    ]);
  }
  function selectedLanguage(recipe: RecipePresentation | null = null): ParticipationLanguage {
    const s = settings();
    return temporary && temporary.until > now()
      ? temporary.language
      : s.language === 'inherit'
        ? (recipe?.language ?? 'en')
        : s.language;
  }
  const api = {
    settings,
    save(expectedRevision: number, input: unknown) {
      const next = settingsSchema.parse(input);
      const result = database.client.transaction(() => {
        const record = read();
        if (record.settings.revision !== expectedRevision)
          throw new ParticipationError('Broadcast preferences changed. Reload before saving.');
        record.settings = { ...next, revision: expectedRevision + 1 };
        write(record);
        return record.settings;
      })();
      temporary = null;
      deps.changed();
      return result;
    },
    view(language?: ParticipationLanguage): ParticipationView {
      const s = settings(),
        lang = language ?? (s.language === 'inherit' ? 'en' : s.language),
        c = copy[lang];
      const interactions: ParticipationView['interactions'] = [];
      if (!deps.blocked())
        for (const automation of repo.automations()) {
          if (!automation.activeVersionId || !['live', 'paused'].includes(automation.status))
            continue;
          const v = repo.version(automation.activeVersionId);
          if (!v || v.approvedAt === null || v.incident || v.status !== 'active') continue;
          try {
            repo.assertVersionLineage(v.id);
          } catch {
            continue;
          }
          const parsed = manifestSchema.safeParse(v.manifest);
          if (!parsed.success) continue;
          const m = parsed.data,
            e = m.experience,
            snapshot = repo.session(automation.id)?.snapshot;
          const phase = automation.status === 'paused' ? 'paused' : (snapshot?.phase ?? 'running');
          const facts = ruleCopy(m, lang);
          const target = e?.objective.kind === 'collective-goal' ? e.objective.target : null;
          interactions.push({
            id: automation.id,
            title: v.title.slice(0, 120),
            phase,
            free: m.trigger.audience.includes('viewer'),
            ...facts,
            command: e?.contribution.command ?? m.trigger.command,
            joinCommands: e?.teams.map((team) => team.joinCommand) ?? [],
            audience: [...m.trigger.audience],
            goal:
              target !== null
                ? { target, current: Math.min(target, snapshot?.scores.community ?? 0) }
                : null,
            remainingMs:
              e && snapshot
                ? phase === 'running' && snapshot.deadlineAt !== null
                  ? Math.max(0, snapshot.deadlineAt - now())
                  : snapshot.remainingMs
                : null,
            scores:
              e && snapshot
                ? Object.entries(snapshot.scores)
                    .slice(0, 8)
                    .map(([key, score]) => ({
                      label: e.teams.find((t) => t.id === key)?.label ?? c.community,
                      score,
                    }))
                : [],
            // Elimination has no reviewed translation yet; it is shown as a finished round.
            outcome: snapshot?.outcome
              ? phaseCopy(lang, snapshot.outcome === 'elimination' ? 'finished' : snapshot.outcome)
              : null,
          });
          if (interactions.length >= 20) break;
        }
      return {
        language: lang,
        stopped: deps.blocked(),
        reducedMotion: s.reducedMotion,
        highContrast: s.highContrast,
        helpCommand: `!riff help ${lang}`,
        interactions,
      };
    },
    /** Cached public view for the unauthenticated companion; see VIEW_CACHE_MS. */
    publicView(language?: ParticipationLanguage): ParticipationView {
      const key = language ?? '',
        at = now(),
        current = stamp(language),
        hit = cache.get(key);
      if (hit && hit.stamp === current && at - hit.at < VIEW_CACHE_MS) return hit.view;
      const view = api.view(language);
      cache.set(key, { at, stamp: current, view });
      return view;
    },
    exportPresentation(original: RecipePackage['presentation']): RecipePackage['presentation'] {
      const s = settings();
      // Optional keys appear only when true so pre-F40 editions keep their digest.
      return {
        language: s.language === 'inherit' ? original.language : s.language,
        reducedMotion: s.reducedMotion || original.reducedMotion,
        ...(s.highContrast || original.highContrast === true ? { highContrast: true } : {}),
        ...(s.effectLabels || original.effectLabels === true ? { effectLabels: true } : {}),
      };
    },
    presentation(versionId: string, recipe: InstalledPresentation | null) {
      const v = repo.version(versionId);
      if (!v) return null;
      const parsed = manifestSchema.safeParse(v.manifest);
      if (!parsed.success) return null;
      const s = settings(),
        language = selectedLanguage(recipe),
        facts = ruleCopy(parsed.data, language);
      const phase = repo.session(v.automationId)?.snapshot.phase;
      const prefix = recipe?.displayName;
      const instructions = [...facts.instructions];
      if (prefix) instructions[0] = `${prefix} · ${instructions[0]}`.slice(0, 200);
      if (phase)
        instructions.push(`${phaseCopy(language, phase)} · ${facts.objective}`.slice(0, 200));
      return {
        instructions: instructions.slice(0, 4),
        reducedMotion: s.reducedMotion || recipe?.reducedMotion === true,
        highContrast: s.highContrast || recipe?.highContrast === true,
        effectLabels: s.effectLabels || recipe?.effectLabels === true,
        // A late arrival's accepted help pulses the guidance even when no text changes.
        ...(helpUntil > now() ? { help: true as const } : {}),
      };
    },
    help(message: LiveChatMessage) {
      const match = /^!riff help(?: (en|fr|es|de))?$/i.exec(message.text.trim());
      if (!match) return { consumed: false, accepted: false };
      if (
        closed ||
        deps.blocked() ||
        message.channelId !== repo.channelId ||
        (message.sourceChannelId && message.sourceChannelId !== message.channelId)
      )
        return { consumed: true, accepted: false };
      if (
        !message.id ||
        message.id.length > 160 ||
        !message.viewerId ||
        message.viewerId.length > 160
      )
        return { consumed: true, accepted: false };
      const at = now(),
        key = createHash('sha256')
          .update(repo.channelId + ':' + message.viewerId)
          .digest('hex'),
        event = createHash('sha256').update(message.id).digest('hex');
      const accepted = database.client.transaction(() => {
        const r = read();
        r.events = Object.fromEntries(Object.entries(r.events).filter(([, t]) => t > at - 600000));
        r.viewers = Object.fromEntries(Object.entries(r.viewers).filter(([, t]) => t > at - 30000));
        r.responses = r.responses.filter((t) => t > at - 60000);
        if (
          r.events[event] !== undefined ||
          r.viewers[key] !== undefined ||
          r.responses.length >= 6 ||
          Object.keys(r.events).length >= 1000 ||
          Object.keys(r.viewers).length >= 1000
        )
          return false;
        r.events[event] = at;
        r.viewers[key] = at;
        r.responses.push(at);
        write(r);
        return true;
      })();
      if (accepted) {
        // Unqualified help uses each recipe/channel preference, never a previous
        // request's language. Only an explicit language creates a timed override, and
        // never over an operator's explicit broadcast language: the shared panel stays
        // in the channel language while the help highlight still shows.
        temporary =
          match[1] && settings().language === 'inherit'
            ? { language: match[1].toLowerCase() as ParticipationLanguage, until: at + HELP_MS }
            : null;
        helpUntil = at + HELP_MS;
        clearTimeout(timer);
        timer = setTimeout(() => {
          temporary = null;
          helpUntil = 0;
          deps.changed();
        }, HELP_MS);
        timer.unref();
        deps.changed();
      }
      return { consumed: true, accepted };
    },
    stop() {
      temporary = null;
      helpUntil = 0;
      clearTimeout(timer);
    },
    close() {
      closed = true;
      temporary = null;
      helpUntil = 0;
      clearTimeout(timer);
    },
  };
  return api;
}
export type ParticipationService = ReturnType<typeof createParticipationService>;
