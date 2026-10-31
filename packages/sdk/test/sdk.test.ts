import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CAPABILITIES, SDK_GUIDE, SDK_VERSION } from '../src/index.js';

it('SDK.md is exactly the guide embedded in the compiler prompt', () => {
  expect(readFileSync(new URL('../SDK.md', import.meta.url), 'utf8')).toBe(SDK_GUIDE);
  expect(SDK_GUIDE).toContain(`Riff SDK ${SDK_VERSION}`);
});

it('documents every enabled capability', () => {
  for (const capability of CAPABILITIES)
    expect(SDK_GUIDE).toContain(`capability \`${capability}\``);
});
