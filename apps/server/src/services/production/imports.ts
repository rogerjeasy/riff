import type { ProductionImportReport, ProductionMapping } from '@riff/sdk';
import { z } from 'zod';
import { ProductionError } from './contract.js';
import { LIMITS, readNativeImport } from './native/index.js';
import type { Runtime } from './runtime.js';
import type { createMappings } from './mappings.js';

export const importToolSchema = z.enum(['streamerbot', 'firebot', 'obs']);
export const previewSchema = z
  .object({ tool: importToolSchema, text: z.string().max(LIMITS.textBytes + 1) })
  .strict();
export const draftSchema = previewSchema
  .extend({
    decisions: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-f0-9]{16}$/),
            decision: z.enum(['intent', 'bridge', 'skip']),
            versionId: z.string().uuid().optional(),
            control: z.enum(['start', 'pause']).optional(),
          })
          .strict(),
      )
      .max(LIMITS.items),
  })
  .strict();
export type PreviewInput = z.infer<typeof previewSchema>;
export type DraftInput = z.infer<typeof draftSchema>;

const LEDGER_MAX = 1000;

/**
 * Native configuration import. Preview is pure parsing plus the drafted ledger; drafting
 * stages bridge mappings through the existing review (never approval) and returns
 * proposed authoring intents for the creator to compile through the normal pipeline.
 * Item ids are deterministic, so re-importing the same export is idempotent.
 */
export function createImports(rt: Runtime, mappings: ReturnType<typeof createMappings>) {
  const ledgerKey = (tool: string, id: string) => `${tool}:${id}`;
  function annotate(report: ProductionImportReport): ProductionImportReport {
    const ledger = rt.read().imports ?? {};
    return {
      ...report,
      items: report.items.map((i) => ({
        ...i,
        drafted: ledger[ledgerKey(report.tool, i.id)] ?? null,
      })),
    };
  }

  function preview(input: PreviewInput) {
    rt.assertRunning();
    const body = previewSchema.parse(input);
    return annotate(readNativeImport(body.tool, body.text));
  }

  function draft(input: DraftInput) {
    rt.assertRunning();
    const body = draftSchema.parse(input);
    const report = readNativeImport(body.tool, body.text);
    const byId = new Map(report.items.map((i) => [i.id, i]));
    const bridges: ProductionMapping[] = [];
    const intents: { id: string; name: string; text: string }[] = [];
    const recorded: [string, 'intent' | 'bridge'][] = [];
    for (const d of body.decisions) {
      const item = byId.get(d.id);
      if (!item)
        throw new ProductionError(
          'INVALID',
          'An item you chose is no longer in this export. Preview the import again.',
        );
      if (d.decision === 'skip') continue;
      if (d.decision === 'intent') {
        if (!item.intent)
          throw new ProductionError(
            'INVALID',
            `"${item.name}" has no recognised trigger and actions to describe as an interaction.`,
          );
        intents.push({ id: item.id, name: item.name, text: item.intent });
        recorded.push([item.id, 'intent']);
        continue;
      }
      if (body.tool === 'obs' || !item.bridge)
        throw new ProductionError(
          'INVALID',
          `"${item.name}" cannot become a bridge: only Streamer.bot or Firebot items with a recognised trigger can.`,
        );
      if (!d.versionId || !d.control)
        throw new ProductionError(
          'INVALID',
          `Choose the approved interaction and operation for the "${item.name}" bridge.`,
        );
      bridges.push({
        id: `import-${item.id}`,
        eventName: item.bridge,
        versionId: d.versionId,
        control: d.control,
        actionId: null,
        tool: body.tool,
      });
      recorded.push([item.id, 'bridge']);
    }
    if (bridges.length) mappings.stageDrafts(bridges);
    if (recorded.length)
      rt.mutate((s) => {
        const ledger = new Map(Object.entries(s.imports ?? {}));
        for (const [id, kind] of recorded) {
          // Re-insert so the newest drafts are kept when the ledger is trimmed.
          ledger.delete(ledgerKey(body.tool, id));
          ledger.set(ledgerKey(body.tool, id), kind);
        }
        const entries = [...ledger];
        s.imports = Object.fromEntries(entries.slice(Math.max(0, entries.length - LEDGER_MAX)));
      });
    if (recorded.length)
      rt.record(
        'IMPORTED',
        `Drafted ${intents.length} interaction${intents.length === 1 ? '' : 's'} and ${bridges.length} bridge mapping${bridges.length === 1 ? '' : 's'} from a ${report.tool === 'streamerbot' ? 'Streamer.bot' : report.tool === 'firebot' ? 'Firebot' : 'OBS'} export. Nothing was approved or run.`,
      );
    return { state: rt.view(), report: annotate(report), intents };
  }

  return { preview, draft };
}
