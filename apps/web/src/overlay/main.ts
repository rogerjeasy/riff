import { renderCommunity } from './community.js';
import type { Community } from '../community/schema.js';
import { overlayMessageSchema } from './messages.js';
import { createSceneOverlay } from '../scenes/live.js';
import type { ExperienceDefinition, SessionSnapshot } from '../lib/types.js';
import { clearStage } from '../effects/projectile.js';
import './overlay.css';

// The overlay is a read-only consumer: it validates every message, ignores unknown
// types, never sends commands and clears itself when the server goes quiet.

const root = document.getElementById('overlay-root') as HTMLElement;
const stage = document.getElementById('stage') as HTMLElement;
const instructions = document.getElementById('instructions') as HTMLElement;
const notice = document.getElementById('notice') as HTMLElement;
const params = new URLSearchParams(location.search);
const key = params.get('key') ?? '';
const showLabels = params.get('labels') === '1';
const reducedMotion =
  params.get('motion') === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches;
const sceneOverlay = createSceneOverlay(stage, { reducedMotion, showLabels });
let watchdog: ReturnType<typeof setTimeout> | undefined;
let retry = 0;
let community: Community | null = null;
const communityRoot = document.createElement('section');
communityRoot.className = 'overlay-community';
communityRoot.setAttribute('aria-label', 'Community co-creation');
root.append(communityRoot);
function renderCommunitySafely() {
  const area = sceneOverlay.communityRegion();
  renderCommunity(communityRoot, area ? community : null, Date.now());
  // A compact card in the bottom-right corner of the free area, never stretched across it.
  if (area)
    Object.assign(communityRoot.style, {
      left: 'auto',
      top: 'auto',
      right: `${(1000 - area.x - area.width) / 10}%`,
      bottom: `${(1000 - area.y - area.height) / 10}%`,
      maxWidth: `min(520px, ${area.width / 10}%)`,
      maxHeight: `${area.height / 10}%`,
      overflow: 'hidden',
    });
}
let sessions: {
  automationId: string;
  versionId?: string | undefined;
  definition: ExperienceDefinition;
  snapshot: SessionSnapshot;
}[] = [];
setInterval(() => {
  sceneOverlay.render();
  renderCommunitySafely();
}, 250);
function clearOverlay(withdrawCommunity = true) {
  if (withdrawCommunity) {
    community = null;
    renderCommunity(communityRoot, null, Date.now());
  }
  clearStage(stage);
  setInstructions([]);
  sessions = [];
  sceneOverlay.clear();
  notice.hidden = true;
}

function setInstructions(lines: string[]) {
  instructions.replaceChildren(
    ...lines.map((line) => {
      const p = document.createElement('p');
      const match = line.match(/^(Type )(\S+)(.*)$/);
      if (match) {
        const b = document.createElement('b');
        b.textContent = match[2] ?? '';
        p.append(match[1] ?? '', b, match[3] ?? '');
      } else p.textContent = line;
      return p;
    }),
  );
  instructions.hidden = lines.length === 0 || params.get('instructions') === '0';
}
function flash(text: string) {
  notice.textContent = text;
  notice.hidden = false;
  setTimeout(() => (notice.hidden = true), 3500);
}
function armWatchdog() {
  clearTimeout(watchdog);
  // No heartbeat for 5 s: the server may be gone; never leave stale effects on air.
  watchdog = setTimeout(() => {
    clearOverlay();
    root.dataset.mode = 'disconnected';
  }, 5000);
}
function connect() {
  if (!key) {
    root.dataset.mode = 'inactive';
    return;
  }
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(
    `${scheme}://${location.host}/ws/overlay?key=${encodeURIComponent(key)}`,
  );
  socket.onmessage = (event) => {
    let parsed;
    let raw: unknown;
    try {
      raw = JSON.parse(String(event.data)) as unknown;
      parsed = overlayMessageSchema.safeParse(raw);
    } catch {
      return;
    }
    if (!parsed.success) {
      if (
        raw &&
        typeof raw === 'object' &&
        'type' in raw &&
        (raw.type === 'scenes' || raw.type === 'sessions')
      ) {
        sceneOverlay.clear();
        sessions = [];
      }
      if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'community') {
        // A rejected replacement cannot leave withdrawn text cached on screen.
        community = null;
        renderCommunity(communityRoot, null, Date.now());
      }
      return;
    }
    armWatchdog();
    const data = parsed.data;
    if (data.type === 'hello') {
      retry = 0;
      root.dataset.mode = 'live';
    } else if (data.type === 'effect') {
      sceneOverlay.effect(data.payload);
    } else if (data.type === 'instructions') setInstructions([]);
    else if (data.type === 'scenes') {
      sceneOverlay.setScenes(data.payload.scenes);
      sceneOverlay.setSessions(sessions);
      renderCommunitySafely();
    } else if (data.type === 'sessions') {
      sessions = data.payload.sessions;
      sceneOverlay.setSessions(sessions);
    } else if (data.type === 'community') {
      // The broker fences publication during panic; a fresh frame also resumes
      // community on the same socket after explicit channel recovery.
      community = data.payload;
      renderCommunitySafely();
    } else if (data.type === 'clear') {
      clearOverlay(data.payload.reason !== 'pause');
    } else if (data.type === 'test') flash('✓ Riff overlay connected');
  };
  socket.onclose = (event) => {
    clearTimeout(watchdog);
    clearOverlay();
    root.dataset.mode = event.code === 4001 ? 'unauthorized' : 'reconnecting';
    if (event.code === 4001) return; // rotated or wrong key: stop until the URL changes
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 500 * 2 ** retry);
  };
}
connect();
