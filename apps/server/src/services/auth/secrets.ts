import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** AES-256-GCM sealing for tokens at rest. The key is derived from RIFF_SECRET. */
export function createSealer(secret: string) {
  if (secret.length < 32) throw new Error('RIFF_SECRET must be at least 32 characters');
  const key = createHash('sha256').update(`riff-token-key:${secret}`).digest();
  return {
    seal(value: unknown): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return [
        'v1',
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        body.toString('base64url'),
      ].join('.');
    },
    open(sealed: string): unknown {
      const [version, iv, tag, body] = sealed.split('.');
      if (version !== 'v1' || !iv || !tag || !body) throw new Error('Unsupported sealed value');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(body, 'base64url')),
        decipher.final(),
      ]);
      return JSON.parse(plain.toString('utf8')) as unknown;
    },
  };
}
export type Sealer = ReturnType<typeof createSealer>;
