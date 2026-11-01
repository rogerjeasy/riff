/**
 * Recognizable credential shapes. Ordinary words ("authorization", "access_token") and
 * plain URLs are allowed in public copy; only values that look like real tokens, keys or
 * URLs carrying credentials are refused.
 */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/, // JSON Web Token
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/, // OpenAI/Stripe-style secret keys
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\boauth:[a-z0-9]{20,}/i, // Twitch chat token form
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, // URL with user:password@
];
const EMBEDDED_DATA = /\bdata:[^\s,;]*;base64,/i;

export type PublicTextProblem = { field: string; kind: 'credential' | 'embedded' };

/** Walk keys and string values; report the first field holding credential-like text. */
export function findPrivateText(value: unknown, field = ''): PublicTextProblem | null {
  if (typeof value === 'string') {
    if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value)))
      return { field: field || 'recipe', kind: 'credential' };
    if (EMBEDDED_DATA.test(value)) return { field: field || 'recipe', kind: 'embedded' };
    return null;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const problem = findPrivateText(item, `${field}[${index}]`);
      if (problem) return problem;
    }
    return null;
  }
  if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      const path = field ? `${field}.${key}` : key;
      const problem = findPrivateText(key, path) ?? findPrivateText(item, path);
      if (problem) return problem;
    }
  return null;
}
