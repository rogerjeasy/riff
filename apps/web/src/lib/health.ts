import { z } from 'zod';

const healthSchema = z.object({
  status: z.literal('ok'),
  mode: z.literal('foundation'),
  integrations: z.literal('disabled'),
});

export async function fetchHealth(signal: AbortSignal) {
  const response = await fetch('/api/health', { signal });
  if (!response.ok) throw new Error('Host is unavailable');
  return healthSchema.parse(await response.json());
}
