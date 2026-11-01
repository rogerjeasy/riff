import type { ProductionBotKind } from '@riff/sdk';
import { digest, eventSchema } from './contract.js';
import { BOT_KINDS, explain, toolName, toolOf, type Runtime } from './runtime.js';

const MAX_PENDING = 16;

/**
 * Inbound Custom.Event dispatch and outbound round-finished actions. Every decision
 * is recorded in `recent` in plain language. Receipts persist before dispatch.
 */
export function createEvents(rt: Runtime) {
  const { deps, state } = rt;
  let pending = 0,
    observing = false;
  const titled = (versionId: string) => {
    const title = deps.repo.version(versionId)?.title;
    return title ? `"${title}"` : 'the pinned version';
  };

  /** Durable receipt claim; false for duplicates or exceeded budgets. */
  function claim(id: string, causal: string) {
    return rt.mutate((s) => {
      const at = Math.max(rt.now(), ...s.receipts.map((r) => r.at));
      s.receipts = s.receipts.filter((r) => r.at > at - 600000);
      if (
        s.receipts.some((r) => r.id === id || r.causal === causal) ||
        s.receipts.filter((r) => r.at > at - 60000).length >= 60 ||
        s.receipts.length >= 2000
      )
        return false;
      s.receipts.push({ id, causal, at });
      return true;
    });
  }

  async function receive(raw: unknown, tool: ProductionBotKind = 'streamerbot') {
    const tName = toolName[tool];
    if (
      raw &&
      typeof raw === 'object' &&
      (raw as { unauthenticated?: unknown }).unauthenticated === true
    ) {
      const name = String((raw as { eventName?: unknown }).eventName ?? '').slice(0, 120);
      rt.record(
        'DENIED',
        `Ignored ${tName} event "${name}": its Riff event key was missing or did not match.`,
      );
      return;
    }
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) {
      rt.record(
        'DENIED',
        `Ignored a ${tName} event without valid Riff causal metadata (args.riff).`,
      );
      return;
    }
    const {
        eventName,
        args: { riff: meta },
      } = parsed.data,
      label = `"${eventName}"`;
    const skip = (code: string, why: string) => rt.record(code, `Event ${label} ${why}`);
    try {
      rt.assertRunning();
      if (!rt.botFor(tool) || rt.connections[tool].status !== 'connected')
        return skip('IGNORED', `was ignored because ${tName} is not connected.`);
      if (state.busy[tool])
        return skip('BUSY', `was not applied because the ${tName} connection is changing.`);
      const s = rt.read(),
        mapping = s.mappings.find((m) => m.eventName === eventName && toolOf(m) === tool);
      if (!mapping) return skip('IGNORED', 'was ignored: no approved mapping uses this event.');
      if (meta.origin === s.origin)
        return skip('IGNORED', 'was ignored: it came from this Riff instance (loop protection).');
      if (meta.at < rt.now() - 120000 || meta.at > rt.now() + 30000)
        return skip(
          'DENIED',
          'was not applied: it is more than two minutes old or over 30 seconds in the future.',
        );
      if (pending >= MAX_PENDING)
        return skip(
          'BUSY',
          `was not applied: ${MAX_PENDING} external controls are already pending.`,
        );
      const stamp = rt.stampFor(tool, true);
      rt.currentVersion(mapping.versionId);
      if (!claim(meta.eventId, meta.causalId))
        return skip(
          'DUPLICATE',
          'was not applied: it repeats an earlier event or cause, or exceeds the event rate limit.',
        );
      rt.fence(stamp);
      pending++;
      try {
        await deps.control(mapping.versionId, mapping.control);
      } finally {
        pending--;
      }
      rt.fence(stamp);
      skip('ACCEPTED', `applied: ${mapping.control} ${titled(mapping.versionId)}.`);
    } catch (error) {
      skip(
        'DENIED',
        `was not applied: ${explain(error, 'the local interaction refused the control.')}`,
      );
    }
  }

  async function observe() {
    if (state.closed || deps.blocked() || observing) return;
    observing = true;
    try {
      for (const tool of BOT_KINDS) await observeTool(tool);
    } finally {
      observing = false;
    }
  }

  async function observeTool(tool: ProductionBotKind) {
    const client = rt.botFor(tool);
    if (!client || state.busy[tool] || rt.connections[tool].status !== 'connected') return;
    const stamp = rt.stampFor(tool, true),
      tName = toolName[tool];
    for (const mapping of rt.read().mappings) {
      if (!mapping.actionId || toolOf(mapping) !== tool) continue;
      const action =
        rt.connections[tool].actions.find((a) => a.id === mapping.actionId)?.name ??
        mapping.actionId;
      try {
        rt.fence(stamp);
        const v = rt.currentVersion(mapping.versionId),
          session = deps.repo.session(v.automationId);
        if (session?.snapshot.phase !== 'finished' || session.versionId !== v.id) continue;
        const id = `finish:${digest({ session: session.snapshot.id, mapping: mapping.id, version: v.id })}`;
        // Unlike recent incoming event receipts, a finished round stays finished.
        // Retain its claim until this mapping sees a different round, including
        // uncertain write results; elapsed time never replays an external effect.
        const first = rt.mutate((s) => {
          if (s.completed[mapping.id] === session.snapshot.id) return false;
          s.completed[mapping.id] = session.snapshot.id;
          return true;
        });
        if (!first || !claim(id, id)) continue;
        rt.fence(stamp);
        await client.invoke(mapping.actionId, {
          riff: { eventId: id, causalId: id, origin: rt.read().origin, hops: 1, at: rt.now() },
        });
        rt.fence(stamp);
        rt.record(
          'SENT',
          `Ran ${tName} action "${action}" once because ${titled(v.id)} finished its round.`,
        );
      } catch (error) {
        rt.record(
          'UNAVAILABLE',
          `${tName} action "${action}" for a finished round was not confirmed: ${explain(error, `${tName} did not accept it.`)} It will not be retried.`,
        );
      }
    }
  }

  return { receive, observe };
}
