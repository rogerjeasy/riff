/** Explicit operator-selected coordinator origin; never accept URLs from peer responses. */
export function coordinatorUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid coordinator origin.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    url.hostname.startsWith('169.254.') ||
    url.hostname === '[::]' ||
    url.hostname === '0.0.0.0'
  )
    throw new Error(
      'Use an HTTPS coordinator origin without credentials, path, query or fragment (HTTP is allowed on loopback).',
    );
  return url.origin;
}

/** Read at most `limit` bytes of a response body, then release it. */
async function bounded(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The coordinator returned no response.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new Error('The coordinator response was too large.');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export type PeerAction = 'review' | 'approve' | 'heartbeat' | 'input' | 'leave' | 'handoff';
export type PeerTransport = ReturnType<typeof createPeerTransport>;
/** Bounded authenticated requests. No redirects, URL secrets, cookies, or automatic event retries. */
export function createPeerTransport(fetcher: typeof fetch = globalThis.fetch) {
  return async (
    origin: string,
    token: string,
    action: PeerAction,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const deadline = AbortSignal.timeout(4000);
    const response = await fetcher(`${coordinatorUrl(origin)}/peer/collaboration/${action}`, {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!response.ok) {
      // A short, plain explanation from the coordinator helps the invited creator act;
      // anything oversized, multi-line or malformed falls back to local wording.
      let explained: string | null = null;
      try {
        const message = (JSON.parse(await bounded(response, 2048)) as { message?: unknown })
          .message;
        if (
          typeof message === 'string' &&
          message.length <= 240 &&
          /^[\p{L}\p{N}\p{P}\p{Zs}\p{S}]+$/u.test(message)
        )
          explained = message;
      } catch {
        /* Fall back to local wording. */
      }
      const fallback =
        response.status === 401 || response.status === 403
          ? 'The coordinator denied this invitation or membership. Request a new invitation.'
          : 'The coordinator could not complete this action. Refresh before trying again.';
      throw new Error(explained ? `Coordinator: ${explained}` : fallback);
    }
    return JSON.parse(await bounded(response, 512 * 1024)) as unknown;
  };
}
