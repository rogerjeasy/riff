import { createRuntime, type ProductionDeps } from './runtime.js';
import { createConnections } from './connections.js';
import { createObsSetup } from './obs-setup.js';
import { createMappings } from './mappings.js';
import { createEvents } from './events.js';
import { createImports } from './imports.js';

/**
 * Host-only production service. Composition only: `runtime` owns storage, epochs and
 * deadlines; `connections`, `obs-setup`, `mappings`, `events` and `imports` own one concern each.
 */
export function createProductionService(deps: ProductionDeps) {
  const rt = createRuntime(deps);
  const events = createEvents(rt);
  const connections = createConnections(rt, (raw, kind) => {
    void events.receive(raw, kind);
  });
  const obs = createObsSetup(rt);
  const mappings = createMappings(rt);
  const imports = createImports(rt, mappings);
  return {
    view: rt.view,
    connect: connections.connect,
    disconnect: connections.disconnect,
    reviewObs: obs.review,
    applyObs: obs.apply,
    confirmObs: obs.confirm,
    rollbackObs: obs.rollback,
    reviewMappings: mappings.review,
    approveMappings: mappings.approve,
    discardMappings: mappings.discard,
    importConfiguration: mappings.importConfiguration,
    previewImport: imports.preview,
    draftImport: imports.draft,
    receive: events.receive,
    observe: events.observe,
    stop: () => rt.stop(),
    close() {
      rt.state.closed = true;
      rt.stop();
    },
  };
}
export type ProductionService = ReturnType<typeof createProductionService>;
