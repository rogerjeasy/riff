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
  it('accepts only known compiler transports and strong secrets', () => {
    expect(() => parseEnv({ RIFF_COMPILER_MODE: 'sdk' })).toThrow();
    expect(parseEnv({ RIFF_COMPILER_MODE: 'codex' }).compilerMode).toBe('codex');
    expect(() => parseEnv({ RIFF_SECRET: 'short' })).toThrow();
    expect(parseEnv({ TWITCH_CLIENT_ID: 'a' }).twitch).toBeNull();
  });
});
