/** F27 install links: `/recipes/install?from=<directory origin>&digest=<sha256>`. */
const DIGEST = /^[a-f0-9]{64}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export type InstallLink =
  | { kind: 'local'; digest: string }
  | { kind: 'remote'; digest: string; from: string }
  | { kind: 'invalid'; message: string };

/**
 * Read an install link, including the older `#<digest>` form. Another directory is never
 * fetched: it must be HTTPS (or loopback HTTP) and the creator downloads the file there.
 */
export function parseInstallLink(location: {
  search: string;
  hash: string;
  origin: string;
}): InstallLink {
  const params = new URLSearchParams(location.search);
  const digest = (params.get('digest') ?? location.hash.slice(1)).toLowerCase();
  if (!DIGEST.test(digest))
    return {
      kind: 'invalid',
      message:
        'This install link has no valid recipe digest. Copy the link again from the directory.',
    };
  const from = params.get('from');
  if (!from) return { kind: 'local', digest };
  let url: URL;
  try {
    url = new URL(from);
  } catch {
    return { kind: 'invalid', message: 'The directory named by this link is not a web address.' };
  }
  if (url.origin === location.origin) return { kind: 'local', digest };
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))
    return {
      kind: 'invalid',
      message: 'Install links must name an HTTPS directory. Ask the publisher for a secure link.',
    };
  return { kind: 'remote', digest, from: url.origin };
}

/** Install link for one edition of the directory at `origin`. */
export const installLinkFor = (origin: string, digest: string) =>
  `${origin}/recipes/install?${new URLSearchParams({ from: origin, digest }).toString()}`;
