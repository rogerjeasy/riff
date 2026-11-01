import type { SharedProjection } from '../collaboration/schema.js';
const statuses = {
  waiting: 'Starting soon',
  running: 'Shared round live',
  paused: 'Paused',
  finished: 'Round finished',
};
const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
/**
 * Read-only aggregate view. No private identities, markup, or optimistic score changes.
 * Between coordinator updates the countdown is interpolated locally from when the frame arrived;
 * scores only ever change when an authoritative frame does.
 */
export function renderCollaboration(
  root: HTMLElement,
  projection: SharedProjection | null,
  layout?: { width: number; height: number; now: number; receivedAt?: number },
) {
  root.replaceChildren();
  root.hidden = !projection;
  if (!projection) {
    root.removeAttribute('aria-label');
    return;
  }
  root.dataset.mode = projection.status;
  root.dataset.shared = 'true';
  const compact = !!layout && (layout.width < 360 || layout.height < 220);
  root.style.padding = compact ? '6px' : '';
  root.style.fontSize = compact ? '14px' : '';
  root.style.gap = compact ? '4px' : '';
  const add = (tag: 'p' | 'h2' | 'strong' | 'div' | 'span', text: string, className: string) => {
    const element = root.ownerDocument.createElement(tag);
    element.textContent = text;
    element.className = className;
    root.append(element);
    return element;
  };
  const remaining =
    projection.remaining === undefined
      ? undefined
      : projection.status === 'running' && layout?.receivedAt !== undefined
        ? Math.max(0, projection.remaining - Math.max(0, layout.now - layout.receivedAt))
        : projection.remaining;
  const reached =
    projection.score !== undefined &&
    projection.target !== undefined &&
    projection.score >= projection.target;
  const status =
    projection.status === 'finished' && reached
      ? 'Goal reached together'
      : statuses[projection.status];
  const command = /\btype (![a-z0-9_-]+)/i.exec(projection.instructions)?.[1];
  const partners = projection.partners?.length ? `with ${projection.partners.join(' and ')}` : '';
  const values: string[] = [];
  if (projection.score !== undefined)
    values.push(
      `${projection.score}${projection.target !== undefined ? ` / ${projection.target}` : ''} points`,
    );
  const over = projection.status === 'finished';
  if (remaining !== undefined && !over) values.push(`${clock(remaining)} left`);
  if (projection.contributions !== undefined)
    values.push(`${projection.contributions} from this channel`);
  root.setAttribute(
    'aria-label',
    [
      status,
      projection.title,
      projection.roleLabel,
      partners,
      projection.instructions,
      ...values,
      projection.reason,
    ]
      .filter(Boolean)
      .join('. '),
  );
  if (compact && layout) {
    add('p', status, 'cc-kicker').style.fontSize = '12px';
    // Page bounded text instead of shrinking type or drawing outside the safe card box.
    const capacity = Math.max(
      12,
      Math.floor((layout.width - 12) / 8) * Math.max(1, Math.floor((layout.height - 36) / 19)),
    );
    const texts = [
      projection.instructions,
      ...values,
      projection.reason,
      `${projection.title} · ${projection.roleLabel}`,
    ].filter((s): s is string => !!s);
    const pages = texts.flatMap((text) => {
      const chars = Array.from(text),
        chunks: string[] = [];
      for (let offset = 0; offset < chars.length; offset += capacity)
        chunks.push(chars.slice(offset, offset + capacity).join(''));
      return chunks;
    });
    add('p', pages[Math.floor(layout.now / 4000) % pages.length] ?? '', '');
    return;
  }
  add('p', `${status} · ${projection.roleLabel}`, 'cc-kicker');
  add('h2', projection.title, 'cc-title');
  if (partners) add('p', partners, 'shared-partners');
  if (command && (projection.status === 'running' || projection.status === 'waiting'))
    add('p', `Type ${command}`, 'shared-cta');
  if (projection.score !== undefined && projection.target !== undefined) {
    const bar = add('div', '', 'shared-meter');
    bar.setAttribute('aria-hidden', 'true');
    const fill = root.ownerDocument.createElement('span');
    fill.style.width = `${Math.min(100, (projection.score / projection.target) * 100)}%`;
    bar.append(fill);
  }
  if (values.length) add('strong', values.join(' · '), 'community-excerpt');
  // Once the round is over, the result matters; the old call to action would mislead.
  if (!over) add('p', projection.instructions, 'community-vote');
  if (projection.reason) add('p', projection.reason, 'cc-note');
}
