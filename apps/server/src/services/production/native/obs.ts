import { z } from 'zod';
import { ProductionError } from '../contract.js';
import { asArray, asRecord, basename, clean, type Found } from './common.js';

/**
 * OBS Studio scene collection JSON (`basic/scenes/<name>.json`). Top-level keys are
 * written in obs-studio `frontend/widgets/OBSBasic_SceneCollections.cpp` (`name`,
 * `sources`, `groups`, `scene_order`, `current_scene`, `modules`); each source's
 * `name`/`id`/`settings` in `libobs/obs.c`; scene `items` in `libobs/obs-scene.c`
 * (checked November 1, 2026). Read as an inventory only — OBS is changed solely by
 * the reviewed overlay setup after an authenticated connection.
 */
const collectionSchema = z
  .object({
    name: z.string().optional(),
    sources: z.array(z.unknown()),
    scene_order: z.array(z.unknown()).optional(),
    groups: z.array(z.unknown()).optional(),
    modules: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const MEDIA = new Set(['ffmpeg_source', 'vlc_source', 'image_source', 'slideshow', 'slideshow_v2']);
/** Built-in OBS source ids kept as a count only: they have no Riff meaning. */
const BUILT_IN = new Set([
  'color_source',
  'color_source_v2',
  'color_source_v3',
  'text_gdiplus',
  'text_gdiplus_v2',
  'text_gdiplus_v3',
  'text_ft2_source',
  'text_ft2_source_v2',
  'dshow_input',
  'av_capture_input',
  'av_capture_input_v2',
  'macos-avcapture',
  'v4l2_input',
  'window_capture',
  'game_capture',
  'monitor_capture',
  'display_capture',
  'screen_capture',
  'xcomposite_input',
  'pipewire-desktop-capture-source',
  'pipewire-window-capture-source',
  'wasapi_input_capture',
  'wasapi_output_capture',
  'wasapi_process_output_capture',
  'coreaudio_input_capture',
  'coreaudio_output_capture',
  'sck_audio_capture',
  'pulse_input_capture',
  'pulse_output_capture',
  'group',
]);

/** Only the host is shown; paths, query strings and overlay keys never are. */
function browserTarget(settings: Record<string, unknown>) {
  if (settings.is_local_file === true)
    return `local file "${basename(settings.local_file) ?? 'unknown'}"`;
  if (typeof settings.url !== 'string') return 'no address';
  try {
    const url = new URL(settings.url);
    return {
      host: clean(url.host, 80) ?? 'unknown host',
      overlay: /\/overlay\/?$/.test(url.pathname),
    };
  } catch {
    return 'an unreadable address';
  }
}

export function readObs(doc: unknown) {
  const parsed = collectionSchema.safeParse(doc);
  if (!parsed.success)
    throw new ProductionError(
      'INVALID',
      'This is not an OBS scene collection. In OBS use Scene Collection → Export and import the .json file.',
    );
  const found: Found[] = [];
  const notes: string[] = [];
  let inventory = 0;
  const order = parsed.data.scene_order?.map((s) => clean(asRecord(s)?.name, 120)) ?? [];
  const sources = parsed.data.sources.map(asRecord).filter((s) => s !== null);
  const scenes = sources
    .filter((s) => s.id === 'scene')
    .sort((a, b) => {
      const ia = order.indexOf(clean(a.name, 120)),
        ib = order.indexOf(clean(b.name, 120));
      return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
    });
  for (const scene of scenes) {
    const name = clean(scene.name, 120) ?? 'Unnamed scene';
    const contents = asArray(asRecord(scene.settings)?.items)
      .map((i) => clean(asRecord(i)?.name, 40))
      .filter((n): n is string => !!n);
    found.push({
      kind: 'scene',
      key: clean(scene.uuid, 120) ?? name,
      name,
      actions: [{ kind: 'scene', detail: name }],
      reason: contents.length
        ? `Scene with ${contents.length} source${contents.length === 1 ? '' : 's'}: ${contents.slice(0, 8).join(', ')}${contents.length > 8 ? ', …' : ''}.`
        : 'Empty scene.',
    });
  }
  for (const source of sources) {
    const id = clean(source.id, 60) ?? 'unknown';
    if (id === 'scene') continue;
    const name = clean(source.name, 120) ?? 'Unnamed source';
    const key = clean(source.uuid, 120) ?? `${id}:${name}`;
    const settings = asRecord(source.settings) ?? {};
    if (id === 'browser_source') {
      const target = browserTarget(settings);
      found.push({
        kind: 'source',
        key,
        name,
        reason:
          typeof target === 'string'
            ? `Browser source showing ${target}.`
            : target.overlay
              ? `Browser source that looks like a Riff overlay on ${target.host}. Adopt it through OBS overlay setup after connecting OBS.`
              : `Browser source showing a page on ${target.host}.`,
      });
    } else if (MEDIA.has(id)) {
      const file = basename(settings.local_file ?? settings.file);
      found.push({
        kind: 'source',
        key,
        name,
        actions: [{ kind: 'media', detail: file ?? name }],
        reason: `Media source${file ? ` playing "${file}"` : ''}; usable as a play-media target.`,
      });
    } else if (BUILT_IN.has(id)) inventory++;
    else
      found.push({
        kind: 'source',
        key,
        name,
        skip: `Plugin source type "${id}" has no Riff equivalent and was not imported.`,
      });
  }
  if (inventory)
    notes.push(
      `${inventory} capture, text, colour, audio or group source${inventory === 1 ? ' was' : 's were'} read for reference only.`,
    );
  const modules = parsed.data.modules ?? {};
  // The scripting tool saves `{ "scripts-tool": [{ path, settings }] }` through the
  // frontend save callback (obs-studio plugins/frontend-tools/scripts.cpp).
  for (const script of asArray(modules['scripts-tool'])) {
    const name = basename(asRecord(script)?.path) ?? 'Unnamed script';
    found.push({
      kind: 'script',
      key: `script:${name}`,
      name,
      review: [`OBS script "${name}" was not imported or run; review it manually.`],
    });
  }
  for (const key of Object.keys(modules))
    if (key !== 'scripts-tool') notes.push(`Plugin data for "${clean(key, 60)}" was not imported.`);
  return { title: clean(parsed.data.name, 120), found, notes };
}
