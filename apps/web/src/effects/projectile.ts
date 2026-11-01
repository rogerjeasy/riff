/**
 * Trusted renderer shared by the private rehearsal stage and the live overlay.
 * Generated code never supplies markup: it chooses an asset and a launch position,
 * the host draws only these owned SVGs with compositor-friendly transforms.
 */
export type Asset = 'tomato' | 'star' | 'heart';

const SVG: Record<Asset, string> = {
  tomato: `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><radialGradient id="tg" cx="35%" cy="32%" r="70%"><stop offset="0" stop-color="#ff8a6b"/><stop offset=".55" stop-color="#e8402a"/><stop offset="1" stop-color="#a81e12"/></radialGradient></defs><circle cx="32" cy="36" r="24" fill="url(#tg)"/><ellipse cx="24" cy="27" rx="7" ry="4.5" fill="#fff" opacity=".35"/><path d="M32 14c-3 3-9 3-12 1 3 4 7 5 10 4-2 3-2 6 0 8 1-3 3-5 6-6 2 2 6 2 9 0-3-1-5-3-6-5 3 0 6-2 7-5-4 1-8 1-11-1z" fill="#3fa34d"/><path d="M32 8v8" stroke="#2c7a37" stroke-width="3" stroke-linecap="round"/></svg>`,
  star: `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="sg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff3a8"/><stop offset="1" stop-color="#f5b000"/></linearGradient></defs><path d="M32 5l7.8 16.6 18.2 2.2-13.4 12.5 3.5 18L32 45.4 15.9 54.3l3.5-18L6 23.8l18.2-2.2z" fill="url(#sg)" stroke="#c98a00" stroke-width="2" stroke-linejoin="round"/></svg>`,
  heart: `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="hg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9ad5"/><stop offset="1" stop-color="#e5307f"/></linearGradient></defs><path d="M32 56S6 40 6 22c0-8 6-14 13.5-14C25 8 29.5 11 32 15.5 34.5 11 39 8 44.5 8 52 8 58 14 58 22c0 18-26 34-26 34z" fill="url(#hg)"/><ellipse cx="20" cy="20" rx="6" ry="4" fill="#fff" opacity=".35"/></svg>`,
};
const SPLAT: Record<Asset, string> = {
  tomato: '#e8402a',
  star: '#f5b000',
  heart: '#e5307f',
};

export interface LaunchOptions {
  asset: Asset;
  intensity?: number | undefined;
  /** Normalized launch position in [0, 1]. */
  x: number;
  /** Normalized target point inside the stage. */
  target?: { x: number; y: number };
  label?: string | null;
  reducedMotion?: boolean;
  /** Maximum simultaneous projectiles; extra effects are dropped, never queued. */
  maxActive?: number;
}

export function assetMarkup(asset: Asset) {
  return SVG[asset];
}

/** Launch one projectile into `stage`. Returns false when dropped by the budget. */
export function launch(stage: HTMLElement, options: LaunchOptions): boolean {
  const max = options.maxActive ?? 12;
  if (stage.querySelectorAll('[data-projectile]').length >= max) return false;
  const width = stage.clientWidth || 1280;
  const height = stage.clientHeight || 720;
  const intensity = Number.isFinite(options.intensity)
    ? Math.max(25, Math.min(100, options.intensity ?? 100))
    : 100;
  const size = (Math.max(36, Math.min(96, width * 0.06)) * intensity) / 100;
  const target = options.target ?? { x: 0.5, y: 0.42 };
  const startX = Math.min(1, Math.max(0, options.x)) * (width - size);
  const startY = height + size;
  const jitter = (Math.min(1, Math.max(0, options.x)) - 0.5) * width * 0.12;
  const endX = target.x * width - size / 2 + jitter;
  const endY = target.y * height - size / 2;
  const node = document.createElement('div');
  node.dataset.projectile = options.asset;
  node.className = 'riff-projectile';
  node.style.width = `${size}px`;
  node.style.height = `${size}px`;
  // Translation moves the node; only the inner sprite spins, so labels stay upright.
  const sprite = document.createElement('div');
  sprite.className = 'riff-sprite';
  sprite.innerHTML = SVG[options.asset];
  node.append(sprite);
  if (options.label) {
    const tag = document.createElement('span');
    tag.className = 'riff-projectile-label';
    tag.textContent = options.label.slice(0, 25); // textContent escapes viewer names
    node.append(tag);
  }
  stage.append(node);
  const done = () => node.remove();
  if (options.reducedMotion || typeof node.animate !== 'function') {
    node.style.transform = `translate(${endX}px, ${endY}px)`;
    node.style.opacity = '1';
    setTimeout(done, 1400);
    return true;
  }
  const peak = Math.min(startY, endY) - height * 0.18;
  const midX = (startX + endX) / 2;
  const flight = node.animate(
    [
      { transform: `translate(${startX}px, ${startY}px) scale(.9)`, offset: 0 },
      { transform: `translate(${midX}px, ${peak}px) scale(1.05)`, offset: 0.55 },
      { transform: `translate(${endX}px, ${endY}px) scale(1)`, offset: 1 },
    ],
    { duration: 820, easing: 'cubic-bezier(.3,.1,.4,1)', fill: 'forwards' },
  );
  sprite.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(400deg)' }], {
    duration: 820,
    easing: 'ease-out',
    fill: 'forwards',
  });
  flight.onfinish = () => {
    sprite.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true" class="riff-splat"><path fill="${SPLAT[options.asset]}" d="M50 18c6 0 8 10 14 8s10-8 14-3-4 11 0 16 14 4 13 11-12 5-13 11 8 12 2 16-11-4-16 1-3 14-11 13-6-11-12-11-11 9-17 5 1-12-4-17-15 0-15-7 11-7 12-13-9-11-4-16 11 2 15-2 1-14 8-14 9 10 14 9z"/><circle cx="18" cy="30" r="5" fill="${SPLAT[options.asset]}"/><circle cx="86" cy="72" r="4" fill="${SPLAT[options.asset]}"/><circle cx="74" cy="14" r="3" fill="${SPLAT[options.asset]}"/></svg>`;
    node.animate(
      [
        { transform: `translate(${endX}px, ${endY}px) scale(.4)`, opacity: 1 },
        { transform: `translate(${endX}px, ${endY}px) scale(1.25)`, opacity: 0.95, offset: 0.2 },
        { transform: `translate(${endX}px, ${endY + 18}px) scale(1.3)`, opacity: 0 },
      ],
      { duration: 1300, easing: 'ease-out', fill: 'forwards' },
    ).onfinish = done;
  };
  return true;
}

export function clearStage(stage: HTMLElement) {
  for (const node of stage.querySelectorAll('[data-projectile]')) node.remove();
}
