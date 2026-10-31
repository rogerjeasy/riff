import { z } from 'zod';
import { clearStage, launch, type Asset } from '../effects/projectile.js';
import './overlay.css';

// The overlay is a read-only consumer: it validates every message, ignores unknown
// types, never sends commands and clears itself when the server goes quiet.
const message = z.discriminatedUnion('type', [
  z.object({
    v: z.literal(1),
    type: z.literal('hello'),
    payload: z.object({ channel: z.string() }),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal('heartbeat'),
    payload: z.object({ at: z.number() }),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal('effect'),
    payload: z.object({
      id: z.string(),
      asset: z.enum(['tomato', 'star', 'heart']),
      x: z.number().min(0).max(1),
      viewer: z.string().max(100).nullable(),
    }),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal('instructions'),
    payload: z.object({ lines: z.array(z.string().max(200)).max(4) }),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal('clear'),
    payload: z.object({ reason: z.string() }),
  }),
  z.object({ v: z.literal(1), type: z.literal('test'), payload: z.object({ at: z.number() }) }),
]);

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
    clearStage(stage);
    setInstructions([]);
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
      parsed = message.safeParse(JSON.parse(String(event.data)));
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
    else if (data.type === 'clear') clearStage(stage);
    else if (data.type === 'test') flash('✓ Riff overlay connected');
  };
  socket.onclose = (event) => {
    root.dataset.mode = event.code === 4001 ? 'unauthorized' : 'reconnecting';
    if (event.code === 4001) return; // rotated or wrong key: stop until the URL changes
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 500 * 2 ** retry);
  };
}
connect();
