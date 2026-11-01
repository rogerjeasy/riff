import { OBSWebSocket } from 'obs-websocket-js';
import { z } from 'zod';
import { ToolRefusal, type ObsTransport } from '../../services/production/contract.js';
/** OBS WebSocket v5, RPC 1. Only this closed operation set reaches the client. */
export function createObsTransport(onClose: () => void): ObsTransport {
  const obs = new OBSWebSocket();
  obs.on('ConnectionClosed', onClose);
  obs.on('ConnectionError', onClose);
  return {
    async connect(url, password) {
      // obs-websocket-js 5.x strips `authentication` from connect()'s result; the raw
      // Hello is only observable through its `Hello` event, emitted before Identify.
      let required = false;
      const onHello = (hello: { authentication?: unknown }) => {
        required = !!hello.authentication;
      };
      obs.once('Hello', onHello);
      try {
        await obs.connect(url, password, { rpcVersion: 1, eventSubscriptions: 0 });
      } catch (error) {
        // 4009 is obs-websocket's AuthenticationFailed close code.
        if ((error as { code?: unknown }).code === 4009)
          throw new ToolRefusal('OBS rejected the password. Check the OBS WebSocket password.');
        throw error;
      } finally {
        obs.off('Hello', onHello);
      }
      if (!required) {
        await obs.disconnect().catch(() => {});
        throw new ToolRefusal(
          'OBS WebSocket authentication is disabled. Enable authentication in OBS WebSocket settings, then reconnect.',
        );
      }
    },
    disconnect() {
      void obs.disconnect().catch(() => {});
    },
    async scenes() {
      // The service bounds and filters the list for display; one oversized name must
      // not refuse the whole connection.
      const response = await obs.call('GetSceneList');
      return z
        .array(z.object({ sceneName: z.string() }))
        .parse(response.scenes)
        .map((s) => s.sceneName);
    },
    async input(scene, name) {
      const items = await obs.call('GetSceneItemList', { sceneName: scene });
      const rows = z
        .array(z.object({ sourceName: z.string() }))
        .max(500)
        .parse(items.sceneItems);
      if (!rows.some((i) => i.sourceName === name)) {
        const existing = await obs.call('GetInputList');
        const all = z
          .array(z.object({ inputName: z.string() }))
          .max(1000)
          .parse(existing.inputs);
        if (all.some((i) => i.inputName === name))
          throw new ToolRefusal('That source belongs to another scene. Choose a new source name.');
        return null;
      }
      if (rows.filter((i) => i.sourceName === name).length !== 1)
        throw new ToolRefusal('The selected source appears more than once in this scene.');
      // An input is global in OBS. Prove that an update will not affect a different
      // scene, including indirect references through nested scenes and groups.
      const list = await obs.call('GetSceneList');
      const scenes = z
        .array(z.object({ sceneName: z.string() }))
        .max(200)
        .parse(list.scenes);
      const graph = new Map<string, string[]>();
      const groups = new Set<string>();
      const rowSchema = z
        .array(z.object({ sourceName: z.string(), isGroup: z.boolean().optional() }))
        .max(500);
      for (const item of scenes) {
        const value = await obs.call('GetSceneItemList', { sceneName: item.sceneName });
        const children = rowSchema.parse(value.sceneItems);
        graph.set(
          item.sceneName,
          children.map((i) => i.sourceName),
        );
        for (const row of children) if (row.isGroup) groups.add(row.sourceName);
      }
      const visitedGroups = new Set<string>();
      for (const group of groups) {
        if (visitedGroups.size >= 100)
          throw new ToolRefusal('Too many grouped sources to verify safely.');
        visitedGroups.add(group);
        const value = await obs.call('GetGroupSceneItemList', { sceneName: group });
        const children = rowSchema.parse(value.sceneItems);
        graph.set(
          group,
          children.map((i) => i.sourceName),
        );
        for (const row of children)
          if (row.isGroup && !visitedGroups.has(row.sourceName)) groups.add(row.sourceName);
      }
      const reaches = (node: string, seen = new Set<string>()): boolean => {
        if (node === name) return true;
        if (seen.has(node)) return false;
        seen.add(node);
        return (graph.get(node) ?? []).some((child) => reaches(child, seen));
      };
      if (scenes.some((s) => s.sceneName !== scene && reaches(s.sceneName)))
        throw new ToolRefusal(
          'That source also appears in another scene. Create a separate Riff source for this scene.',
        );
      const result = await obs.call('GetInputSettings', { inputName: name });
      if (result.inputKind !== 'browser_source')
        throw new ToolRefusal('Only an owned Riff browser source can be updated.');
      const settings = z.record(z.string(), z.unknown()).parse(result.inputSettings);
      if (JSON.stringify(settings).length > 16384)
        throw new ToolRefusal('Source settings are too large.');
      return settings;
    },
    async write(scene, name, settings, create, restore = false) {
      // Restoration receives only the sealed original snapshot from the host service.
      // OBS may omit default fields in that snapshot; preserve it verbatim instead
      // of imposing the dimensions required for a newly configured browser source.
      const safe = z.record(z.string(), z.json()).parse(settings);
      if (Buffer.byteLength(JSON.stringify(safe)) > 16384)
        throw new ToolRefusal('Source settings are too large.');
      if (restore) {
        if (create) throw new ToolRefusal('An original snapshot cannot create a new source.');
      } else {
        z.object({
          url: z.string(),
          width: z.number(),
          height: z.number(),
          shutdown: z.boolean().optional(),
          restart_when_active: z.boolean().optional(),
        })
          .passthrough()
          .parse(safe);
      }
      if (create)
        await obs.call('CreateInput', {
          sceneName: scene,
          inputName: name,
          inputKind: 'browser_source',
          inputSettings: safe,
          sceneItemEnabled: true,
        });
      else
        await obs.call('SetInputSettings', {
          inputName: name,
          inputSettings: safe,
          overlay: false,
        });
    },
    async remove(scene, name) {
      const response = await obs.call('GetSceneItemList', { sceneName: scene });
      const rows = z
        .array(z.object({ sourceName: z.string(), sceneItemId: z.number().int() }))
        .max(500)
        .parse(response.sceneItems)
        .filter((i) => i.sourceName === name);
      const [item] = rows;
      if (rows.length !== 1 || !item)
        throw new ToolRefusal('The reviewed scene item changed or is missing.');
      await obs.call('RemoveSceneItem', { sceneName: scene, sceneItemId: item.sceneItemId });
    },
  };
}
