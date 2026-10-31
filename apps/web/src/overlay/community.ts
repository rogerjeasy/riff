import type { Community } from '../community/schema.js';
const PAGE_MS = 3000;
function excerpt(text: string, limit: number) {
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : text;
}
function credit(authors: string[]) {
  const first = authors[0];
  return first
    ? ` · ${excerpt(first, 16)}${authors.length > 1 ? ` +${authors.length - 1} credited` : ''}`
    : '';
}
/** Bounded excerpts and explicit rotation keep every option/command reachable on air. */
export function renderCommunity(root: HTMLElement, projection: Community | null, now: number) {
  root.replaceChildren();
  root.hidden = !projection;
  if (!projection) return;
  const line = (parent: HTMLElement, text: string, tag = 'p', className = '') => {
    const element = document.createElement(tag);
    element.textContent = text;
    element.className = className;
    parent.append(element);
    return element;
  };
  line(root, 'Create with the community', 'h2');
  for (const command of projection.commands) line(root, excerpt(command, 48));
  line(root, excerpt(projection.creditNotice, 120), 'small');
  const viewport = root.ownerDocument.defaultView;
  const compact = (viewport?.innerHeight ?? 1080) < 700 || (viewport?.innerWidth ?? 1920) < 480;
  const pageSize = compact ? 1 : 3;
  const tick = Math.floor(Math.max(0, now) / PAGE_MS);
  const ballot = projection.ballot ?? projection.outcomes[0];
  if (ballot) {
    const open = ballot.closedAt === null && now < ballot.deadlineAt;
    line(
      root,
      open
        ? `Vote · ${Math.max(0, Math.ceil((ballot.deadlineAt - now) / 1000))}s left`
        : `Results${ballot.tied ? ' · Tie · creator decides' : ' · creator decides'}`,
      'h3',
    );
    const pages = Math.max(1, Math.ceil(ballot.options.length / pageSize));
    const page = tick % pages;
    line(root, `Excerpts · full proposals in creator inbox`, 'small');
    if (pages > 1)
      line(
        root,
        `Options page ${page + 1}/${pages} · all ${ballot.options.length} choices rotate every 3s`,
        'small',
      );
    for (const option of ballot.options.slice(page * pageSize, (page + 1) * pageSize)) {
      const row = line(root, '', 'article', 'community-option');
      line(row, `${option.option}. ${excerpt(option.text, 64)}`, 'p', 'community-excerpt');
      line(row, `${option.votes} votes${credit(option.authors)}`, 'small', 'community-credit');
      if (open) line(row, `!riff vote ${ballot.id} ${option.option}`, 'code', 'community-vote');
    }
  }
  // One selection at a time prevents five long public summaries crowding voting.
  const selection = projection.selections[tick % Math.max(1, projection.selections.length)];
  if (selection && (viewport?.innerHeight ?? 1080) >= 600) {
    const label = selection.status === 'candidate' ? 'Ready for creator review' : selection.status;
    const status = line(root, '', 'footer', 'community-selection');
    line(
      status,
      `${label}${projection.selections.length > 1 ? ` · selection ${(tick % projection.selections.length) + 1}/${projection.selections.length} · rotates every 3s` : ''}`,
      'small',
    );
    line(status, excerpt(selection.text, 64), 'p', 'community-excerpt');
    if (selection.authors.length)
      line(status, credit(selection.authors).slice(3), 'small', 'community-credit');
  }
}
