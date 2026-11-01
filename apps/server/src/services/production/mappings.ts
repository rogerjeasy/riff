import { randomUUID } from 'node:crypto';
import type { ProductionMapping } from '@riff/sdk';
import type { z } from 'zod';
import { ProductionError, digest, importSchema, mappingsSchema } from './contract.js';
import { BOT_KINDS, toolName, toolOf, type Runtime } from './runtime.js';

const MAX_LINES = 100;
const NATIVE_UNSUPPORTED =
  'Only riff-production version 1 mapping JSON is supported here. Use “Import from another tool” to read Streamer.bot, Firebot or OBS exports as reviewable drafts; C#, shell, plugins and scripts are never executed or silently migrated.';
const NOTHING_STAGED = 'Nothing was staged. The approved mappings are unchanged.';

/** Plain-language reasons a riff-production document failed the bounded schema. */
function describeIssues(issues: z.core.$ZodIssue[], raw: Record<string, unknown>) {
  const where = (path: PropertyKey[]) => {
    if (path[0] !== 'mappings' || typeof path[1] !== 'number')
      return path.length ? `"${path.join('.')}"` : 'The document';
    const field = path.slice(2).join('.');
    return `Mapping ${path[1] + 1}${field ? ` field "${field}"` : ''}`;
  };
  return issues.map((issue) => {
    if (issue.code === 'unrecognized_keys') {
      const keys = issue.keys.map((k) => `"${k}"`).join(', ');
      const many = issue.keys.length > 1;
      return `${where(issue.path)} contains unknown field${many ? 's' : ''} ${keys}; ${many ? 'they were' : 'it was'} not executed or imported.`;
    }
    if (issue.code === 'too_big' && issue.path.length === 1 && issue.path[0] === 'mappings')
      return `The document has ${Array.isArray(raw.mappings) ? raw.mappings.length : 'too many'} mappings; at most ${String(issue.maximum)} are supported.`;
    if (issue.code === 'custom') return 'Mapping IDs and event names must each be unique.';
    return `${where(issue.path)}: ${issue.message}.`;
  });
}

/**
 * Bot mapping reviews are staged only; approved mappings stay live until a review is
 * approved. Approval is what changes live dispatch authority (mapping epoch).
 */
export function createMappings(rt: Runtime) {
  const { deps } = rt;
  const versionLabel = (id: string) => {
    const title = deps.repo.version(id)?.title;
    return title ? `version "${title}"` : `unknown version ${id.slice(0, 8)}`;
  };
  const actionLabel = (m: Pick<ProductionMapping, 'tool'>, id: string) =>
    `"${rt.connections[toolOf(m)].actions.find((a) => a.id === id)?.name ?? id}"`;
  const via = (m: ProductionMapping) => (toolOf(m) === 'firebot' ? ' (Firebot)' : '');
  const behaviour = (m: ProductionMapping) =>
    `${m.control} ${versionLabel(m.versionId)}${m.actionId ? `; when its round finishes, run ${actionLabel(m, m.actionId)}` : ''}`;
  const enabledAction = (m: ProductionMapping, id: string) =>
    rt.connections[toolOf(m)].actions.some((a) => a.id === id && a.enabled);

  function differences(current: ProductionMapping[], incoming: ProductionMapping[]) {
    const lines: string[] = [];
    for (const m of incoming) {
      const old = current.find((c) => c.id === m.id);
      if (!old) {
        lines.push(`Add "${m.eventName}"${via(m)} → ${behaviour(m)}.`);
        continue;
      }
      const changes = [
        old.eventName !== m.eventName && `event "${old.eventName}" → "${m.eventName}"`,
        toolOf(old) !== toolOf(m) && `${toolName[toolOf(old)]} → ${toolName[toolOf(m)]}`,
        old.control !== m.control && `${old.control} → ${m.control}`,
        old.versionId !== m.versionId &&
          `${versionLabel(old.versionId)} → ${versionLabel(m.versionId)}`,
        old.actionId !== m.actionId &&
          `finished-round action ${old.actionId ? actionLabel(old, old.actionId) : 'none'} → ${m.actionId ? actionLabel(m, m.actionId) : 'none'}`,
      ].filter(Boolean);
      if (changes.length) lines.push(`Change "${old.eventName}": ${changes.join('; ')}.`);
    }
    for (const old of current)
      if (!incoming.some((m) => m.id === old.id))
        lines.push(`Remove "${old.eventName}" (no longer ${behaviour(old)}).`);
    return lines.length ? lines : ['No changes from the approved mappings.'];
  }

  /** Problems that block approval of an otherwise well-formed mapping. */
  function problems(m: ProductionMapping) {
    const out: string[] = [];
    try {
      rt.currentVersion(m.versionId);
    } catch {
      out.push(
        `Mapping "${m.id}" (${m.eventName}): ${versionLabel(m.versionId)} is not a current, healthy, approved version in this channel.`,
      );
    }
    if (m.actionId && !enabledAction(m, m.actionId))
      out.push(
        `Mapping "${m.id}" (${m.eventName}): action "${m.actionId}" is missing or disabled on the connected ${toolName[toolOf(m)]}.`,
      );
    return out;
  }

  function stage(mappings: ProductionMapping[], unsupported: string[]) {
    rt.mutate((s) => {
      s.mappingReview = {
        digest: digest({
          mappings,
          unsupported,
          connection: rt.state.session.streamerbot,
          firebot: rt.state.session.firebot,
          nonce: randomUUID(),
        }),
        mappings,
        unsupported: unsupported.slice(0, MAX_LINES),
        differences:
          mappings.length || !unsupported.length
            ? differences(s.mappings, mappings).slice(0, MAX_LINES)
            : [NOTHING_STAGED],
      };
    });
    return rt.view();
  }
  function assertIdle() {
    rt.assertRunning();
    for (const kind of BOT_KINDS)
      if (rt.state.busy[kind])
        throw new ProductionError('BUSY', `Wait for the current ${toolName[kind]} operation.`);
  }

  return {
    review(raw: unknown) {
      assertIdle();
      const mappings = mappingsSchema.parse(raw);
      const [problem] = mappings.flatMap(problems);
      if (problem) throw new ProductionError('DENIED', problem);
      return stage(mappings, []);
    },
    approve(hash: string) {
      assertIdle();
      const live = (kind: (typeof BOT_KINDS)[number]) =>
        !!rt.botFor(kind) && rt.connections[kind].status === 'connected';
      const review = rt.read().mappingReview;
      const needed = review?.mappings.length
        ? [...new Set(review.mappings.map(toolOf))]
        : BOT_KINDS.some(live)
          ? []
          : ['streamerbot' as const];
      const missing = needed.find((kind) => !live(kind));
      if (missing)
        throw new ProductionError('UNAVAILABLE', `Connect ${toolName[missing]} before approval.`);
      if (!review || review.digest !== hash || review.unsupported.length)
        throw new ProductionError('STALE', 'Review the exact supported mappings before approval.');
      const [problem] = review.mappings.flatMap(problems);
      if (problem) throw new ProductionError('STALE', problem);
      // Approval replaces live authority: in-flight dispatches under old mappings stop.
      rt.epochs.mapping++;
      rt.mutate((s) => {
        s.mappings = review.mappings;
        // The approved review is consumed; leaving it would offer a stale second approval.
        s.mappingReview = null;
        s.completed = Object.fromEntries(
          review.mappings.flatMap((m) => {
            const version = rt.currentVersion(m.versionId),
              session = deps.repo.session(version.automationId);
            return session?.snapshot.phase === 'finished' ? [[m.id, session.snapshot.id]] : [];
          }),
        );
      });
      return rt.view();
    },
    discard(hash: string) {
      rt.assertRunning();
      const review = rt.read().mappingReview;
      if (!review) return rt.view();
      if (review.digest !== hash)
        throw new ProductionError('STALE', 'The mapping review changed. Reload before discarding.');
      rt.mutate((s) => {
        s.mappingReview = null;
      });
      return rt.view();
    },
    /**
     * Stage imported bridge drafts on top of the approved set (same id replaces).
     * Never approves; problems block approval exactly like a reviewed import.
     */
    stageDrafts(drafts: ProductionMapping[]) {
      assertIdle();
      const current = rt.read().mappings;
      const merged = [...current.filter((m) => !drafts.some((d) => d.id === m.id)), ...drafts];
      const clash = drafts.find((d) =>
        merged.some((m) => m.id !== d.id && m.eventName === d.eventName),
      );
      if (clash)
        throw new ProductionError(
          'INVALID',
          `The event "${clash.eventName}" is already used by another mapping. Remove that mapping first.`,
        );
      const parsed = mappingsSchema.safeParse(merged);
      if (!parsed.success)
        throw new ProductionError(
          'INVALID',
          `At most 20 mappings can be reviewed; ${merged.length} would result. Draft fewer bridges.`,
        );
      return stage(parsed.data, parsed.data.flatMap(problems));
    },
    importConfiguration(raw: unknown) {
      assertIdle();
      if (raw === undefined)
        throw new ProductionError('INVALID', 'Import a JSON configuration object.');
      if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 32768)
        throw new ProductionError('INVALID', 'Configuration must be at most 32 KiB.');
      const doc =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      if (doc?.format !== 'riff-production') return stage([], [NATIVE_UNSUPPORTED]);
      if (doc.version !== 1)
        return stage(
          [],
          [
            `riff-production version ${JSON.stringify(doc.version) ?? 'missing'} is not supported; only version 1 can be imported.`,
          ],
        );
      const parsed = importSchema.safeParse(raw);
      if (!parsed.success) return stage([], describeIssues(parsed.error.issues, doc));
      return stage(parsed.data.mappings, parsed.data.mappings.flatMap(problems));
    },
  };
}
