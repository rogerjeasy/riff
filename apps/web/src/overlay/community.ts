import type { Community } from '../community/schema.js';
import { syncChildren } from '../scenes/render.js';

const PAGE_MS = 4000;
/** Closed results stay on air briefly; history remains in the creator inbox. */
export const RESULTS_ON_AIR_MS = 120_000;
/** A creator pick is announced for a while, then the panel returns to its quiet invite. */
export const SELECTION_ON_AIR_MS = 20 * 60_000;

type Ballot = NonNullable<Community['ballot']>;
type Selection = Community['selections'][number];

const STATUS: Record<Selection['status'], string> = {
  selected: 'Picked by the streamer',
  queued: 'Being built',
  generating: 'Being built',
  candidate: 'Being tested privately',
  applied: 'Now live',
  failed: 'Not ready yet',
};

function excerpt(text: string, limit: number) {
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : text;
}
function credit(authors: string[]) {
  const first = authors[0];
  if (!first) return '';
  return `by ${excerpt(first, 18)}${authors.length > 1 ? ` +${authors.length - 1}` : ''}`;
}
function clock(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function ballotLabel(ballot: Ballot) {
  return ballot.number ? String(ballot.number) : ballot.id;
}

/**
 * Safe, bounded broadcast presentation. Every string goes through `textContent`; the
 * panel shows a one-line invitation when idle so it never crowds the stream.
 */
export function renderCommunity(root: HTMLElement, projection: Community | null, now: number) {
  root.hidden = !projection;
  if (!projection) {
    root.replaceChildren();
    return;
  }
  // Built off-screen, then patched in place: unchanged cards keep their elements, so the
  // vote bars glide and only changed counts pop instead of the card redrawing 4×/second.
  const draft = root.ownerDocument.createElement('div');
  const node = <K extends keyof HTMLElementTagNameMap>(
    parent: HTMLElement,
    tag: K,
    className: string,
    text?: string,
  ) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    parent.append(element);
    return element;
  };
  const viewport = root.ownerDocument.defaultView;
  const height = viewport?.innerHeight ?? 1080;
  const compact = height < 700 || (viewport?.innerWidth ?? 1920) < 480;
  const tick = Math.floor(Math.max(0, now) / PAGE_MS);

  const open = projection.ballot && now < projection.ballot.deadlineAt ? projection.ballot : null;
  const recent = projection.outcomes.find(
    (ballot) => ballot.closedAt !== null && now - ballot.closedAt < RESULTS_ON_AIR_MS,
  );
  const ballot = open ?? recent ?? null;
  const selection = projection.selections.find(
    (item) => item.selectedAt === undefined || now - item.selectedAt < SELECTION_ON_AIR_MS,
  );
  root.dataset.mode = ballot ? (open ? 'vote' : 'results') : selection ? 'selection' : 'invite';

  if (ballot) {
    const head = node(draft, 'header', 'cc-head');
    node(
      head,
      'span',
      'cc-kicker',
      open ? `Chat vote${ballot.number ? ` #${ballot.number}` : ''}` : 'Vote results',
    );
    const timer = node(
      head,
      'span',
      open ? 'cc-timer' : 'cc-timer done',
      open ? clock(ballot.deadlineAt - now) : 'Closed',
    );
    if (open && ballot.deadlineAt - now <= 10_000) timer.dataset.urgent = 'true';
    node(draft, 'h2', 'cc-title', open ? 'Which idea should we build?' : 'Chat has spoken');
    const total = ballot.options.reduce((sum, option) => sum + option.votes, 0);
    const top = Math.max(0, ...ballot.options.map((option) => option.votes));
    const pageSize = compact ? 1 : 5;
    const pages = Math.max(1, Math.ceil(ballot.options.length / pageSize));
    const page = tick % pages;
    const list = node(draft, 'div', 'cc-options');
    for (const option of ballot.options.slice(page * pageSize, (page + 1) * pageSize)) {
      const row = node(list, 'article', 'community-option');
      const leading = top > 0 && option.votes === top;
      if (leading) row.dataset.leading = ballot.tied ? 'tie' : 'true';
      row.style.setProperty('--share', `${total ? Math.round((option.votes / total) * 100) : 0}%`);
      // Same share as a 0–1 factor so the bar can grow with a transform.
      row.style.setProperty('--share-n', total ? (option.votes / total).toFixed(3) : '0');
      node(row, 'span', 'cc-key', String(option.option));
      const body = node(row, 'div', 'cc-body');
      node(body, 'p', 'community-excerpt', excerpt(option.text, 72));
      const by = credit(option.authors);
      if (by) node(body, 'small', 'community-credit', by);
      node(
        row,
        'span',
        'cc-votes',
        `${option.votes} ${option.votes === 1 ? 'vote' : 'votes'}${leading && !open ? (ballot.tied ? ' · tie' : ' · most') : ''}`,
      );
    }
    if (pages > 1) node(draft, 'small', 'cc-page', `Options ${page + 1}/${pages}`);
    if (open) {
      const how = node(draft, 'p', 'community-vote');
      node(how, 'span', '', 'Vote in chat ');
      node(how, 'code', '', `!riff vote ${ballotLabel(ballot)} <number>`);
      node(draft, 'small', 'cc-note', 'Votes advise the streamer, who picks what gets built.');
    } else
      node(
        draft,
        'small',
        'cc-note',
        ballot.tied
          ? 'It is a tie. The streamer decides.'
          : 'The streamer decides what gets built.',
      );
  }

  if (selection && height >= 600 && !(ballot && compact)) {
    const card = node(draft, 'footer', 'community-selection');
    card.dataset.status = selection.status;
    node(
      card,
      'small',
      'cc-kicker',
      `${selection.number ? `Chat idea #${selection.number}` : 'Chat idea'} · ${STATUS[selection.status]}`,
    );
    node(card, 'p', 'community-excerpt', excerpt(selection.text, 72));
    const by = credit(selection.authors);
    if (by) node(card, 'small', 'community-credit', by);
  }

  if (!ballot) {
    const invite = node(draft, 'div', 'cc-invite');
    const line = node(invite, 'p', '');
    node(line, 'span', 'cc-kicker', 'Got an idea?');
    node(line, 'code', '', excerpt(projection.commands[0] ?? '!riff suggest <idea>', 48));
    // Shown wherever submission is presented: chat is public; credit is opt-in.
    node(invite, 'small', 'cc-note', excerpt(projection.creditNotice, 140));
  }
  const still =
    !!root.closest('[data-motion="reduced"]') ||
    (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  syncChildren(root, [...draft.childNodes], (changed) => {
    const votes = changed.closest('.cc-votes');
    if (!votes || still || typeof (votes as HTMLElement).animate !== 'function') return;
    (votes as HTMLElement).animate([{ transform: 'scale(1.25)' }, { transform: 'scale(1)' }], {
      duration: 320,
      easing: 'cubic-bezier(.2,.8,.2,1)',
    });
  });
}
