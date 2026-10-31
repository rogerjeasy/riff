/** Admission control for compile jobs: 1 running per channel, 4 globally, 3 waiting per channel. */
export const QUEUE_LIMITS = Object.freeze({ perChannel: 1, global: 4, pendingPerChannel: 3 });

export class QueueFullError extends Error {
  readonly code = 'QUEUE_FULL';
  constructor() {
    super('Too many generations are waiting for this channel. Cancel one and try again.');
  }
}

interface Waiter {
  channelId: string;
  start: () => void;
  signal: AbortSignal | undefined;
  reject: (error: Error) => void;
}

export interface QueueLimits {
  perChannel: number;
  global: number;
  pendingPerChannel: number;
}

export function createCompileQueue(limits: QueueLimits = QUEUE_LIMITS) {
  const running = new Map<string, number>();
  let total = 0;
  const waiting: Waiter[] = [];
  const pendingFor = (channelId: string) => waiting.filter((w) => w.channelId === channelId).length;
  const canStart = (channelId: string) =>
    total < limits.global && (running.get(channelId) ?? 0) < limits.perChannel;
  function release(channelId: string) {
    total--;
    running.set(channelId, (running.get(channelId) ?? 1) - 1);
    const index = waiting.findIndex((w) => canStart(w.channelId));
    const next = index >= 0 ? waiting.splice(index, 1)[0] : undefined;
    next?.start();
  }
  return {
    /** Position among waiting jobs for a channel (0 = running or next). */
    position(channelId: string) {
      return pendingFor(channelId);
    },
    async run<T>(
      channelId: string,
      job: () => Promise<T>,
      options: { signal?: AbortSignal; onQueued?: (position: number) => void } = {},
    ): Promise<T> {
      if (!canStart(channelId)) {
        if (pendingFor(channelId) >= limits.pendingPerChannel) throw new QueueFullError();
        await new Promise<void>((resolve, reject) => {
          const waiter: Waiter = { channelId, start: resolve, signal: options.signal, reject };
          waiting.push(waiter);
          options.onQueued?.(pendingFor(channelId));
          options.signal?.addEventListener(
            'abort',
            () => {
              const index = waiting.indexOf(waiter);
              if (index >= 0) waiting.splice(index, 1);
              reject(new Error('cancelled'));
            },
            { once: true },
          );
        });
      }
      total++;
      running.set(channelId, (running.get(channelId) ?? 0) + 1);
      try {
        return await job();
      } finally {
        release(channelId);
      }
    },
  };
}
