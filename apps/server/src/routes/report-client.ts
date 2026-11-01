import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

/** Expand an IPv6 address to its eight 16-bit groups, or null when it is not IPv6. */
function ipv6Groups(address: string): string[] | null {
  if (isIP(address) !== 6) return null;
  let text = address.toLowerCase().split('%')[0] ?? '';
  // An embedded dotted IPv4 tail occupies the last two groups.
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const [first = 0, second = 0, third = 0, fourth = 0] = dotted.split('.').map(Number);
    text = `${text.slice(0, -dotted.length)}${((first << 8) | second).toString(16)}:${((third << 8) | fourth).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array.from({ length: missing }, () => '0'), ...right].map((group) =>
    group.padStart(4, '0'),
  );
}

/**
 * The identity used for report rate limits. One IPv6 subscriber usually controls a whole
 * /64, so every address inside it shares one allowance; IPv4-mapped addresses are IPv4.
 */
export function rateClient(address: string): string {
  const plain = address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  const groups = ipv6Groups(plain);
  if (!groups) return plain.slice(0, 64);
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** Caddy overwrites forwarded addresses. Accept its final client only from a private/loopback peer. */
export function reportClient(request: FastifyRequest): string {
  const peer = request.ip.replace(/^::ffff:/, '');
  const octets = peer.split('.').map(Number);
  const privatePeer =
    peer === '::1' ||
    peer.startsWith('fc') ||
    peer.startsWith('fd') ||
    (isIP(peer) === 4 &&
      (octets[0] === 127 ||
        octets[0] === 10 ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31)));
  const forwarded = request.headers['x-forwarded-for'];
  const candidate = (Array.isArray(forwarded) ? forwarded.at(-1) : forwarded)
    ?.split(',')
    .at(-1)
    ?.trim();
  return rateClient(privatePeer && candidate && isIP(candidate) ? candidate : peer);
}
