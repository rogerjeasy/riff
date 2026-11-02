import { describe, expect, it } from 'vitest';
import {
  APPROVAL_CODE_ALPHABET,
  APPROVAL_CODE_LENGTH,
  generateApprovalCode,
  normalizeApprovalCode,
  parseAuthorCommand,
  sanitizeIntent,
  systemReply,
} from '../src/services/chat-authoring/commands.js';

describe('in-chat authoring commands', () => {
  it('parses only the reserved owner verbs and the bare !approve alias', () => {
    expect(parseAuthorCommand('!riff create a tomato toss with !tomato')).toEqual({
      kind: 'create',
      intent: 'a tomato toss with !tomato',
    });
    expect(parseAuthorCommand('  !RIFF Edit make it two per minute ')).toEqual({
      kind: 'edit',
      intent: 'make it two per minute',
    });
    expect(parseAuthorCommand('!riff approve k7q2x')).toEqual({ kind: 'approve', code: 'k7q2x' });
    expect(parseAuthorCommand('!riff reject K7Q2X')).toEqual({ kind: 'reject', code: 'K7Q2X' });
    expect(parseAuthorCommand('!riff approve')).toEqual({ kind: 'approve', code: '' });
    expect(parseAuthorCommand('!riff status')).toEqual({ kind: 'status' });
    expect(parseAuthorCommand('!riff cancel')).toEqual({ kind: 'cancel' });
    expect(parseAuthorCommand('!approve')).toEqual({ kind: 'approve-alias' });
    expect(parseAuthorCommand('!approve now')).toBeNull();
    expect(parseAuthorCommand('!riff creative')).toBeNull();
    expect(parseAuthorCommand('!riff suggest create something')).toBeNull();
    expect(parseAuthorCommand('!riff panic')).toBeNull();
    expect(parseAuthorCommand('please !riff create x')).toBeNull();
  });

  it('treats intent as untrusted text: control characters stripped, 500 code points', () => {
    expect(sanitizeIntent('make\u0000 it\u0007\u001b[31m red\u007f\u0085‮ now')).toBe(
      'make it[31m red now',
    );
    expect(sanitizeIntent('a\n\n\tb')).toBe('a b');
    const long = '😀'.repeat(600);
    expect(Array.from(sanitizeIntent(long))).toHaveLength(500);
    expect(sanitizeIntent('​⁦ ')).toBe('');
  });

  it('issues short codes from an unambiguous alphabet', () => {
    expect(APPROVAL_CODE_LENGTH).toBeGreaterThanOrEqual(4);
    expect(APPROVAL_CODE_LENGTH).toBeLessThanOrEqual(6);
    for (const ambiguous of ['0', 'O', '1', 'I', 'L', '5', 'S', '2', 'Z', '8', 'B'])
      expect(APPROVAL_CODE_ALPHABET).not.toContain(ambiguous);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = generateApprovalCode();
      expect(code).toMatch(new RegExp(`^[${APPROVAL_CODE_ALPHABET}]{${APPROVAL_CODE_LENGTH}}$`));
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(190);
    expect(normalizeApprovalCode(' k7q-3x ')).toBe('K7Q3X');
  });

  it('formats system replies so they can never be read back as commands', () => {
    for (const text of ['!riff panic', '/ban someone', '.color red', 'x'.repeat(900)]) {
      const reply = systemReply(text);
      expect(reply.startsWith('Riff · ')).toBe(true);
      expect(Array.from(reply).length).toBeLessThanOrEqual(500);
    }
    expect(systemReply('Ready\u0000\nnow')).toBe('Riff · Ready now');
  });
});
