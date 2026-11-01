import {
  ProductionError,
  canonical,
  digest,
  setupSchema,
  type ObsTransport,
  type SetupInput,
  type StoredProduction,
} from './contract.js';
import type { Runtime, Stamp } from './runtime.js';

type Settings = Record<string, unknown>;

/**
 * Exact-source OBS setup: review → visible diagnostic (apply) → explicit live
 * confirmation, with a sealed original snapshot for undo. Apply and confirm need the
 * reviewing connection; rollback and re-review of the owned source survive reconnect.
 */
export function createObsSetup(rt: Runtime) {
  const { deps } = rt;
  const testUrl = () => new URL('/production-test', deps.overlayUrl()).toString();
  const persisted = (s: StoredProduction) => {
    if (!s.setup) throw new ProductionError('STALE', 'Review the production setup again.');
    return s.setup;
  };
  const open = (sealed: string) => rt.cipher().open(sealed) as Settings;

  function owned(settings: Settings, target: SetupInput) {
    if (typeof settings.url !== 'string') return false;
    try {
      const current = new URL(settings.url),
        expected = new URL(deps.overlayUrl());
      if (current.username || current.password) return false;
      // A shared host/path is not a channel identity: the scoped key must match too.
      if (current.href === expected.href) return true;
      // The public diagnostic URL has no credential. Adopt it only when this channel
      // itself wrote these exact settings to this exact source (its sealed expected
      // snapshot), including from an earlier connection of the same setup.
      const setup = rt.read().setup;
      return (
        current.href === testUrl() &&
        setup?.public.status === 'test' &&
        setup.urlDigest === digest(deps.overlayUrl()) &&
        setup.public.sceneName === target.sceneName &&
        setup.public.inputName === target.inputName &&
        !!setup.expectedSealed &&
        canonical(open(setup.expectedSealed)) === canonical(settings)
      );
    } catch {
      return false;
    }
  }
  function ready() {
    if (!rt.state.obs || rt.connections.obs.status !== 'connected')
      throw new ProductionError('UNAVAILABLE', 'Connect OBS and allow scene discovery first.');
    return rt.state.obs;
  }
  /** Apply/confirm authority: same digest, same live connection, same overlay URL. */
  function liveSetup(hash: string) {
    const s = rt.read().setup;
    if (
      !s ||
      s.public.digest !== hash ||
      s.connection !== rt.state.session.obs ||
      s.urlDigest !== digest(deps.overlayUrl())
    )
      throw new ProductionError(
        'STALE',
        'OBS setup review is stale. Review the exact source again.',
      );
    return s;
  }
  async function sameInput(
    client: ObsTransport,
    scene: string,
    input: string,
    expected: Settings | null,
    stamp: Stamp,
  ) {
    const value = await client.input(scene, input);
    rt.fence(stamp);
    if (canonical(value) !== canonical(expected))
      throw new ProductionError(
        'STALE',
        'OBS source settings changed outside this review. Inspect and review them again.',
      );
  }
  /** Writes settings, then requires OBS to report them back exactly. */
  async function writeConfirmed(
    client: ObsTransport,
    scene: string,
    input: string,
    settings: Settings,
    create: boolean,
    stamp: Stamp,
    what: string,
  ) {
    await client.write(scene, input, settings, create);
    rt.fence(stamp);
    const actual = await client.input(scene, input);
    rt.fence(stamp);
    if (
      !actual ||
      Object.entries(settings).some(([key, value]) => canonical(actual[key]) !== canonical(value))
    )
      throw new ProductionError(
        'STALE',
        `OBS did not confirm the expected ${what} settings. Inspect the source before retrying.`,
      );
    return actual;
  }

  return {
    review(input: SetupInput) {
      return rt.work('obs', async (stamp) => {
        const b = setupSchema.parse(input),
          client = ready(),
          connection = rt.state.session.obs;
        if (!connection || !rt.connections.obs.scenes.includes(b.sceneName))
          throw new ProductionError('DENIED', 'Select a scene from the approved discovery.');
        const before = await client.input(b.sceneName, b.inputName);
        rt.fence(stamp);
        if (before && !owned(before, b))
          throw new ProductionError(
            'DENIED',
            'Only an existing Riff browser source can be updated. Choose a new source name.',
          );
        const hash = digest({ input: b, before, connection, url: deps.overlayUrl() });
        rt.mutate((s) => {
          s.setup = {
            public: {
              ...b,
              digest: hash,
              operation: before ? 'update' : 'create',
              status: 'review',
              before: before
                ? {
                    width: typeof before.width === 'number' ? before.width : null,
                    height: typeof before.height === 'number' ? before.height : null,
                    mode: 'owned-browser',
                  }
                : null,
            },
            connection,
            beforeSealed: before ? rt.cipher().seal(before) : null,
            expectedSealed: null,
            urlDigest: digest(deps.overlayUrl()),
          };
        });
        return rt.view();
      });
    },
    apply(hash: string) {
      return rt.work('obs', async (stamp) => {
        const setup = liveSetup(hash),
          client = ready(),
          { sceneName, inputName } = setup.public;
        if (setup.public.status === 'test' || setup.public.status === 'live') return rt.view();
        if (setup.public.status !== 'review')
          throw new ProductionError('STALE', 'Review the source again.');
        const before = setup.beforeSealed ? open(setup.beforeSealed) : null;
        await sameInput(client, sceneName, inputName, before, stamp);
        const settings = {
          url: testUrl(),
          width: setup.public.width,
          height: setup.public.height,
          shutdown: true,
          restart_when_active: false,
        };
        const actual = await writeConfirmed(
          client,
          sceneName,
          inputName,
          settings,
          !before,
          stamp,
          'test',
        );
        rt.mutate((s) => {
          persisted(s).public.status = 'test';
          persisted(s).expectedSealed = rt.cipher().seal(actual);
        });
        return rt.view();
      });
    },
    confirm(hash: string) {
      return rt.work('obs', async (stamp) => {
        const setup = liveSetup(hash),
          client = ready(),
          { sceneName, inputName } = setup.public;
        if (setup.public.status === 'live') return rt.view();
        if (setup.public.status !== 'test' || !setup.expectedSealed)
          throw new ProductionError(
            'STALE',
            'Apply the test frame and confirm it is visible before enabling the live source.',
          );
        const expected = open(setup.expectedSealed);
        await sameInput(client, sceneName, inputName, expected, stamp);
        const actual = await writeConfirmed(
          client,
          sceneName,
          inputName,
          { ...expected, url: deps.overlayUrl() },
          false,
          stamp,
          'live',
        );
        rt.mutate((s) => {
          persisted(s).public.status = 'live';
          persisted(s).expectedSealed = rt.cipher().seal(actual);
        });
        return rt.view();
      });
    },
    /** Undo may use a newer connection; unchanged settings are still required. */
    rollback(hash: string) {
      return rt.work('obs', async (stamp) => {
        const setup = rt.read().setup,
          client = ready();
        if (!setup || setup.public.digest !== hash)
          throw new ProductionError('STALE', 'No applied setup with this review to undo.');
        if (setup.public.status === 'rolled-back') return rt.view();
        if (!setup.expectedSealed) throw new ProductionError('STALE', 'No applied setup to undo.');
        const { sceneName, inputName } = setup.public;
        await sameInput(client, sceneName, inputName, open(setup.expectedSealed), stamp);
        if (setup.beforeSealed)
          await client.write(sceneName, inputName, open(setup.beforeSealed), false, true);
        else await client.remove(sceneName, inputName);
        rt.fence(stamp);
        rt.mutate((s) => {
          persisted(s).public.status = 'rolled-back';
        });
        return rt.view();
      });
    },
  };
}
