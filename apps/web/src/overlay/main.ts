import { overlayMessageSchema } from './messages.js';
import { createSessionHud } from '../sessions/presentation.js';
import type { ExperienceDefinition, SessionSnapshot } from '../lib/types.js';
import { clearStage, launch, type Asset } from '../effects/projectile.js';
import './overlay.css';

// The overlay is a read-only consumer: it validates every message, ignores unknown
// types, never sends commands and clears itself when the server goes quiet.

const root = document.getElementById('overlay-root') as HTMLElement;
const stage = document.getElementById('stage') as HTMLElement;
const instructions = document.getElementById('instructions') as HTMLElement;
const notice = document.getElementById('notice') as HTMLElement;
const params = new URLSearchParams(location.search);
const key = params.get('key') ?? '';
const [tx, ty] = (params.get('target') ?? '0.5,0.42').split(',').map(Number);
const target = {
  x: tx !== undefined && Number.isFinite(tx) ? tx : 0.5,
  y: ty !== undefined && Number.isFinite(ty) ? ty : 0.42,
};
const showLabels = params.get('labels') === '1';
const reducedMotion =
  params.get('motion') === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches;
let watchdog: ReturnType<typeof setTimeout> | undefined;
let retry = 0;
const sessionsRoot = document.createElement('div');
sessionsRoot.className = 'overlay-sessions';
root.append(sessionsRoot);
let sessions: { definition: ExperienceDefinition; snapshot: SessionSnapshot }[] = [];
function renderSessions() {
  sessionsRoot.replaceChildren(
    ...sessions.map((session) =>
      createSessionHud(session.definition, session.snapshot, { now: Date.now() }),
    ),
  );
}
setInterval(renderSessions, 1000);
function clearOverlay() {
  clearStage(stage);
  setInstructions([]);
  sessions = [];
  sessionsRoot.replaceChildren();
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
    try {
      parsed = overlayMessageSchema.safeParse(JSON.parse(String(event.data)));
    } catch {
      return;
    }
    if (!parsed.success) return;
    armWatchdog();
    const data = parsed.data;
    if (data.type === 'hello') {
      retry = 0;
      root.dataset.mode = 'live';
    } else if (data.type === 'effect') {
      launch(stage, {
        asset: data.payload.asset as Asset,
        x: data.payload.x,
        target,
        label: showLabels ? data.payload.viewer : null,
        reducedMotion,
      });
    } else if (data.type === 'instructions') setInstructions(data.payload.lines);
    else if (data.type === 'sessions') {
      sessions = data.payload.sessions;
      renderSessions();
    } else if (data.type === 'clear') clearOverlay();
    else if (data.type === 'test') flash('✓ Riff overlay connected');
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
