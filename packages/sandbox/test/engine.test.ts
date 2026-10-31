import { describe, expect, it } from 'vitest';
import * as sandbox from '@riff/sandbox';

const manifest = {
  sdkVersion: '0.2.0',
  capabilities: ['overlay'],
  trigger: { command: '!tomato', audience: ['viewer'], maxPerViewer: 3, windowMs: 60_000 },
  limits: { effectsPerEvent: 1, effectsPerMinute: 60 },
};
const source = `async (event, riff) => { await riff.overlay.emit({kind:'projectile', asset:'tomato', x:riff.util.random()}); }`;
const artifact = { source, manifest };
const event = (id: string, at = 0, viewerId = 'alice') => ({
  id,
  at,
  viewerId,
  channelId: 'channel-a',
  roles: ['viewer'],
  text: '!tomato',
});

describe('preview execution contract', () => {
  it('exports a bounded engine', () => expect(sandbox).toHaveProperty('createPreviewEngine'));
  it('enforces viewer allowances, duplicates and rolling expiration independently of guest code', async () => {
    const engine = sandbox.createPreviewEngine(artifact, 42);
    for (let i = 0; i < 3; i++)
      expect((await engine.dispatch(event(String(i), i))).code).toBe('ACCEPTED');
    expect((await engine.dispatch(event('3', 3))).code).toBe('VIEWER_LIMIT');
    expect((await engine.dispatch(event('4', 4, 'bob'))).code).toBe('ACCEPTED');
    expect((await engine.dispatch(event('0', 5, 'mallory'))).code).toBe('DUPLICATE');
    expect((await engine.dispatch(event('5', 59_999))).code).toBe('VIEWER_LIMIT');
    expect((await engine.dispatch(event('6', 60_000))).code).toBe('ACCEPTED');
    expect((await engine.dispatch(event('7', 60_000))).code).toBe('VIEWER_LIMIT');
    expect((await engine.dispatch(event('8', 60_001))).code).toBe('ACCEPTED');
  });
  it('ignores altered duplicate timestamps without advancing the replay clock', async () => {
    const engine = sandbox.createPreviewEngine(artifact, 42);
    expect((await engine.dispatch(event('a', 0))).code).toBe('ACCEPTED');
    expect((await engine.dispatch(event('a', 100_000))).code).toBe('DUPLICATE');
    expect((await engine.dispatch(event('b', 1))).code).toBe('ACCEPTED');
  });
  it('serializes simultaneous dispatches', async () => {
    const engine = sandbox.createPreviewEngine(artifact, 42);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => engine.dispatch(event(String(i)))),
    );
    expect(results.filter((r) => r.code === 'ACCEPTED')).toHaveLength(3);
    expect(results.filter((r) => r.code === 'VIEWER_LIMIT')).toHaveLength(3);
  });
  it('filters command and trusted audience before evaluation', async () => {
    const engine = sandbox.createPreviewEngine(artifact, 42);
    expect((await engine.dispatch({ ...event('a'), text: '!other' })).code).toBe('UNRELATED');
    const moderators = sandbox.createPreviewEngine(
      {
        ...artifact,
        manifest: { ...manifest, trigger: { ...manifest.trigger, audience: ['moderator'] } },
      },
      42,
    );
    expect((await moderators.dispatch(event('a'))).code).toBe('AUDIENCE');
    expect((await moderators.dispatch({ ...event('b'), roles: ['moderator'] })).code).toBe(
      'ACCEPTED',
    );
  });
  it('runs command, rolling-window and audience edits through the same host checks', async () => {
    const edited = sandbox.createPreviewEngine(
      {
        source: `async(e,r)=>{await r.overlay.emit({kind:'projectile',asset:'star',x:r.util.random()})}`,
        manifest: {
          ...manifest,
          trigger: {
            command: '!splat',
            audience: ['moderator'],
            maxPerViewer: 2,
            windowMs: 30_000,
          },
        },
      },
      42,
    );
    expect((await edited.dispatch(event('old'))).code).toBe('UNRELATED');
    expect((await edited.dispatch({ ...event('viewer'), text: '!splat' })).code).toBe('AUDIENCE');
    const moderator = (id: string, at = 0) => ({
      ...event(id, at),
      text: '!splat',
      roles: ['moderator'],
    });
    expect((await edited.dispatch(moderator('one'))).effects[0]?.asset).toBe('star');
    expect((await edited.dispatch(moderator('two'))).code).toBe('ACCEPTED');
    expect((await edited.dispatch(moderator('three'))).code).toBe('VIEWER_LIMIT');
    expect((await edited.dispatch(moderator('next', 30_000))).code).toBe('ACCEPTED');
  });
  it('replays identical inputs with identical artifact identity and effects', async () => {
    const first = sandbox.createPreviewEngine(artifact, 42);
    const second = sandbox.createPreviewEngine(artifact, 42);
    expect(await first.dispatch(event('a'))).toEqual(await second.dispatch(event('a')));
    expect(
      sandbox.createPreviewEngine({ ...artifact, source: source + ' ' }, 42).artifactId,
    ).not.toBe(first.artifactId);
  });
  it('rejects malformed events without poisoning the run', async () => {
    const engine = sandbox.createPreviewEngine(artifact, 42);
    expect((await engine.dispatch({ ...event('a'), text: 'x'.repeat(501) })).code).toBe(
      'INVALID_EVENT',
    );
    expect((await engine.dispatch(event('b', 5))).code).toBe('ACCEPTED');
    expect((await engine.dispatch(event('c', 4))).code).toBe('INVALID_EVENT');
    expect((await engine.dispatch({ ...event('d', 6), channelId: 'other' })).code).toBe(
      'INVALID_EVENT',
    );
  });
  it('rejects unsupported manifest authority and inflated limits', () => {
    expect(() =>
      sandbox.createPreviewEngine(
        { ...artifact, manifest: { ...manifest, capabilities: ['chat.say'] } },
        42,
      ),
    ).toThrow();
    expect(() =>
      sandbox.createPreviewEngine(
        {
          ...artifact,
          manifest: { ...manifest, limits: { ...manifest.limits, effectsPerEvent: 1000 } },
        },
        42,
      ),
    ).toThrow();
  });
  it.each([
    ['undeclared capability', source, { ...manifest, capabilities: [] }],
    [
      'malformed effect',
      `async(e,r)=>{await r.overlay.emit({kind:'projectile',asset:'tomato',x:NaN})}`,
      manifest,
    ],
    [
      'effect limit',
      `async(e,r)=>{for(let i=0;i<2;i++)await r.overlay.emit({kind:'projectile',asset:'tomato',x:0.5})}`,
      manifest,
    ],
    [
      'bridge limit caught by guest',
      `async(e,r)=>{for(let i=0;i<30;i++){try{await r.overlay.emit({kind:'projectile',asset:'tomato',x:0.5})}catch{}}}`,
      manifest,
    ],
    ['infinite loop', `()=>{while(true){}}`, manifest],
    [
      'promise storm',
      `()=>{function again(){Promise.resolve().then(again)} again(); return new Promise(()=>{});}`,
      manifest,
    ],
    [
      'detached rejection',
      `async(e,r)=>{await r.overlay.emit({kind:'projectile',asset:'tomato',x:0.5});Promise.reject(Error('oops'));}`,
      manifest,
    ],
    [
      'detached async failure',
      `async(e,r)=>{await r.overlay.emit({kind:'projectile',asset:'tomato',x:0.5});(async()=>{throw Error('oops')})();}`,
      manifest,
    ],
    [
      'detached then failure',
      `async(e,r)=>{await r.overlay.emit({kind:'projectile',asset:'tomato',x:0.5});Promise.resolve().then(()=>{throw Error('oops')});}`,
      manifest,
    ],
    [
      'implicit async callback failure',
      `async(e,r)=>{await r.overlay.emit({kind:'projectile',asset:'tomato',x:0.5});[1].forEach(async()=>{throw Error('oops')});}`,
      manifest,
    ],
    ['pending promise', `()=>new Promise(()=>{})`, manifest],
    [
      'fault after effect',
      `async(e,r)=>{await r.overlay.emit({kind:'projectile',asset:'tomato',x:0.5});throw Error('oops')}`,
      manifest,
    ],
    ['memory growth', `()=>{let a=[];for(;;)a.push(new Array(100000).fill('x'));}`, manifest],
  ])('quarantines %s and discards all staged effects', async (_name, guest, permissions) => {
    const engine = sandbox.createPreviewEngine({ source: guest, manifest: permissions }, 42);
    const result = await engine.dispatch(event('a'));
    expect(result.code).toBe('INCIDENT');
    expect(result.effects).toEqual([]);
    expect((await engine.dispatch(event('b'))).code).toBe('DISABLED');
  });
  it.each([
    `()=>{eval('1')}`,
    `()=>{Function('return 1')()}`,
    `()=>{(()=>{}).constructor('return 1')()}`,
    `()=>{(async()=>{}).constructor('return 1')()}`,
    `()=>{Date.now()}`,
    `()=>{Math.random()}`,
    `()=>{fetch('https://example.com')}`,
    `()=>{globalThis.escaped=true}`,
    `()=>import('node:fs')`,
  ])('denies ambient authority: %s', async (guest) => {
    const result = await sandbox
      .createPreviewEngine({ source: guest, manifest }, 42)
      .dispatch(event('a'));
    expect(result.code).toBe('INCIDENT');
  });
  it('recreates closure state for every invocation and isolates each preview', async () => {
    const isolated = {
      manifest,
      source: `(()=>{let count=0;return async(e,r)=>{await r.overlay.emit({kind:'projectile',asset:'star',x:++count/10})}})()`,
    };
    const first = sandbox.createPreviewEngine(isolated, 42);
    expect((await first.dispatch(event('a'))).effects[0]?.x).toBe(0.1);
    expect((await first.dispatch(event('b'))).effects[0]?.x).toBe(0.1);
    const second = sandbox.createPreviewEngine(isolated, 42);
    expect((await second.dispatch(event('a'))).effects[0]?.x).toBe(0.1);
  });
  it('supports synchronous handlers and fences an active worker', async () => {
    const sync = sandbox.createPreviewEngine(
      { manifest, source: `(e,r)=>{r.overlay.emit({kind:'projectile',asset:'tomato',x:0.5})}` },
      42,
    );
    expect((await sync.dispatch(event('a'))).code).toBe('ACCEPTED');
    const pending = sync.dispatch(event('b'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    sync.stop();
    expect((await pending).code).toBe('STOPPED');
  });
  it('fences stopped runs including in-flight work', async () => {
    const engine = sandbox.createPreviewEngine(artifact, 42);
    const pending = engine.dispatch(event('a'));
    engine.stop();
    expect((await pending).code).toBe('STOPPED');
    expect((await engine.dispatch(event('b'))).effects).toEqual([]);
  });
  it('applies aggregate budgets across viewers without consuming denied viewer allowance', async () => {
    const engine = sandbox.createPreviewEngine(
      {
        ...artifact,
        manifest: { ...manifest, limits: { effectsPerEvent: 1, effectsPerMinute: 1 } },
      },
      42,
    );
    expect((await engine.dispatch(event('a'))).code).toBe('ACCEPTED');
    expect((await engine.dispatch(event('b', 1, 'bob'))).code).toBe('CHANNEL_LIMIT');
    expect((await engine.dispatch(event('c', 60_000, 'bob'))).code).toBe('ACCEPTED');
  });
});
