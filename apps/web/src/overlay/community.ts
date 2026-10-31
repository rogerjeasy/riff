import type { Community } from '../community/schema.js';
/** Each frame replaces all prior content, so withdrawn options and credit disappear. */
export function renderCommunity(root: HTMLElement, projection: Community | null, now: number) {
  root.replaceChildren();
  root.hidden = !projection;
  if (!projection) return;
  const line = (parent: HTMLElement, text: string, tag = 'p') => {
    const element = document.createElement(tag);
    element.textContent = text;
    parent.append(element);
    return element;
  };
  line(root, 'Create with the community', 'h2');
  for (const command of projection.commands) line(root, command);
  line(root, projection.creditNotice, 'small');
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
    for (const option of ballot.options) {
      line(
        root,
        `${option.option}. ${option.text} · ${option.votes} votes${option.authors.length ? ` · ${option.authors.join(', ')}` : ''}`,
      );
      if (open) line(root, `!riff vote ${ballot.id} ${option.option}`, 'small');
    }
  }
  for (const selection of projection.selections) {
    line(
      root,
      `${selection.status === 'candidate' ? 'Ready for creator review' : selection.status}: ${selection.text}${selection.authors.length ? ` · ${selection.authors.join(', ')}` : ''}`,
    );
  }
}
