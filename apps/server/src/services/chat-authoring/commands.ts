import { randomInt } from 'node:crypto';

export type AuthorCommand =
  | { kind: 'create' | 'edit'; intent: string }
  | { kind: 'approve' | 'reject'; code: string }
  | { kind: 'approve-alias' | 'status' | 'cancel' };

/** AGENTS §4: viewer-supplied text is capped at 500 characters. */
export const MAX_CHAT_INTENT = 500;

/**
 * Owner authoring verbs. Anything else under `!riff` (suggest, vote, help, panic…)
 * returns null so its existing handler keeps precedence.
 */
export function parseAuthorCommand(text: string): AuthorCommand | null {
  if (/^\s*!approve\s*$/i.test(text)) return { kind: 'approve-alias' };
  const match = /^\s*!riff\s+(create|edit|approve|reject|status|cancel)(?:\s+([\s\S]*))?$/i.exec(
    text,
  );
  if (!match) return null;
  const verb = (match[1] ?? '').toLowerCase();
  const rest = (match[2] ?? '').trim();
  if (verb === 'create' || verb === 'edit') return { kind: verb, intent: rest };
  if (verb === 'approve' || verb === 'reject') return { kind: verb, code: rest };
  if (rest) return null;
  return { kind: verb as 'status' | 'cancel' };
}

// C0, DEL, C1, zero-width and bidirectional formatting characters.
const invisible = (code: number) =>
  code < 0x20 ||
  (code >= 0x7f && code <= 0x9f) ||
  (code >= 0x200b && code <= 0x200f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2060 && code <= 0x2069) ||
  code === 0xfeff;

/** Untrusted chat text → bounded plain intent. Never interpreted, only quoted. */
export function sanitizeIntent(text: string) {
  let cleaned = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) cleaned += ' ';
    else if (!invisible(code)) cleaned += char;
  }
  return Array.from(cleaned.replace(/\s+/g, ' ').trim()).slice(0, MAX_CHAT_INTENT).join('');
}

/** No 0/O, 1/I/L, 2/Z, 5/S, 8/B: read aloud or typed on stream without confusion. */
export const APPROVAL_CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';
export const APPROVAL_CODE_LENGTH = 5;

export function generateApprovalCode() {
  let code = '';
  for (let i = 0; i < APPROVAL_CODE_LENGTH; i++)
    code += APPROVAL_CODE_ALPHABET[randomInt(APPROVAL_CODE_ALPHABET.length)];
  return code;
}

export function normalizeApprovalCode(text: string) {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Host-owned system reply. The fixed prefix means Riff's own message, echoed back over
 * EventSub with broadcaster badges, can never parse as a command or chat slash command.
 */
export function systemReply(text: string) {
  const body = sanitizeIntent(text);
  return Array.from(`Riff · ${body}`).slice(0, 500).join('');
}
