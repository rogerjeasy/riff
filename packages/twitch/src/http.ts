import { z } from 'zod';

/** The subset of `fetch` this package uses; inject `globalThis.fetch` or a test double. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// Twitch error bodies: {"error": "Bad Request", "status": 400, "message": "..."}
// (https://dev.twitch.tv/docs/authentication/refresh-tokens/). All fields optional here.
const twitchErrorBody = z.looseObject({ message: z.string().optional() });

/** Read a body as JSON; undefined when it is empty or not JSON. */
export async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text.length === 0 ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/** Twitch's own error text (never contains our credentials), capped for logs. */
export function twitchMessageOf(body: unknown): string | undefined {
  const parsed = twitchErrorBody.safeParse(body);
  return parsed.success && parsed.data.message !== undefined
    ? parsed.data.message.slice(0, 200)
    : undefined;
}

/** Zod issues as short path strings, without echoing values. */
export function issuePaths(error: z.ZodError): string[] {
  return error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`);
}
