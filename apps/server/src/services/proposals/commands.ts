export type ProposalCommand =
  | { kind: 'suggest'; text: string }
  | { kind: 'vote'; ballotId: string; option: number }
  | { kind: 'shortlist' | 'hide'; proposalId: string }
  | { kind: 'credit'; enabled: boolean }
  | { kind: 'invalid' | 'panic' };
/** Reserved commands are consumed before guest dispatch; panic remains host precedence. */
export function parseProposalCommand(text: string): ProposalCommand | null {
  const match = /^\s*!riff(?:\s+([\s\S]*))?\s*$/i.exec(text);
  if (!match) return null;
  const body = (match[1] ?? '').trim();
  if (/^panic$/i.test(body)) return { kind: 'panic' };
  const suggest = /^suggest(?:\s+([\s\S]*))?$/i.exec(body);
  if (suggest) return { kind: 'suggest', text: suggest[1] ?? '' };
  const vote = /^vote\s+([a-zA-Z0-9_-]{1,128})\s+([1-5])$/i.exec(body);
  if (vote) return { kind: 'vote', ballotId: vote[1] ?? '', option: Number(vote[2]) };
  const moderate = /^(shortlist|hide)\s+([a-zA-Z0-9_-]{1,128})$/i.exec(body);
  if (moderate)
    return {
      kind: (moderate[1] ?? '').toLowerCase() as 'shortlist' | 'hide',
      proposalId: moderate[2] ?? '',
    };
  const credit = /^credit\s+(on|off)$/i.exec(body);
  if (credit) return { kind: 'credit', enabled: (credit[1] ?? '').toLowerCase() === 'on' };
  return { kind: 'invalid' };
}
