import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/env.js';

describe('server configuration', () => {
  it('starts locally with integrations disabled and no credentials', () => {
    expect(parseEnv({})).toMatchObject({ host: '127.0.0.1', port: 8787, compilerMode: 'mock' });
  });
  it.each(['0', '65536', 'text', ''])('rejects invalid port %s', (value) => {
    expect(() => parseEnv({ RIFF_PORT: value })).toThrow();
  });
  it('rejects exposing the unauthenticated foundation on a public interface', () => {
    expect(() => parseEnv({ RIFF_HOST: '0.0.0.0' })).toThrow();
  });
  it('allows a container interface only when explicitly enabled', () => {
    expect(parseEnv({ RIFF_HOST: '0.0.0.0', RIFF_ALLOW_REMOTE: 'true' }).host).toBe('0.0.0.0');
  });
  it('rejects enabling an unimplemented compiler transport', () => {
    expect(() => parseEnv({ RIFF_COMPILER_MODE: 'sdk' })).toThrow();
  });
});
