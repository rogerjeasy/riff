import { gunzipSync } from 'node:zlib';
import type { ProductionImportReport, ProductionImportTool } from '@riff/sdk';
import { ProductionError } from '../contract.js';
import { LIMITS, TOOL_LABEL, finalize } from './common.js';
import { readFirebot } from './firebot.js';
import { readObs } from './obs.js';
import { readStreamerBot } from './streamer-bot.js';

export { LIMITS } from './common.js';

const tooLarge = () =>
  new ProductionError(
    'INVALID',
    `The decoded configuration is too large; at most ${LIMITS.decodedBytes / 1024} KiB can be imported.`,
  );

function gunzip(bytes: Buffer) {
  try {
    return gunzipSync(bytes, { maxOutputLength: LIMITS.decodedBytes });
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge();
    throw new ProductionError('INVALID', 'The compressed import string is damaged.');
  }
}

/**
 * Turn pasted text into JSON. Streamer.bot shares actions as an import string.
 * UNVERIFIED: that string is assumed to be base64 of a 4-byte "SBAE" header followed
 * by gzip-compressed JSON; plain base64 gzip and plain JSON are also accepted.
 */
function decode(tool: ProductionImportTool, text: string): unknown {
  const trimmed = text.trim();
  let json = trimmed;
  if (tool === 'streamerbot' && !/^[[{]/.test(trimmed)) {
    if (!/^[A-Za-z0-9+/=\s]+$/.test(trimmed))
      throw new ProductionError(
        'INVALID',
        'Paste the Streamer.bot export string or its JSON; this text is neither.',
      );
    const bytes = Buffer.from(trimmed.replace(/\s+/g, ''), 'base64');
    const body =
      bytes.subarray(0, 4).toString('latin1') === 'SBAE'
        ? gunzip(bytes.subarray(4))
        : bytes[0] === 0x1f && bytes[1] === 0x8b
          ? gunzip(bytes)
          : bytes;
    if (body.length > LIMITS.decodedBytes) throw tooLarge();
    json = body.toString('utf8');
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new ProductionError(
      'INVALID',
      `This ${TOOL_LABEL[tool]} file could not be read as JSON. Export it again and import the unmodified file.`,
    );
  }
}

/**
 * Read a native export into an import report. Pure: no I/O, storage or execution.
 * Scripts and code are listed for manual review; unknown parts are never guessed.
 */
export function readNativeImport(tool: ProductionImportTool, text: string): ProductionImportReport {
  if (Buffer.byteLength(text, 'utf8') > LIMITS.textBytes)
    throw new ProductionError(
      'INVALID',
      `Imports are limited to ${LIMITS.textBytes / 1024} KiB. Export fewer items and import them in parts.`,
    );
  if (!text.trim()) throw new ProductionError('INVALID', 'Paste or upload an export first.');
  const doc = decode(tool, text);
  const read =
    tool === 'firebot' ? readFirebot(doc) : tool === 'obs' ? readObs(doc) : readStreamerBot(doc);
  const result = finalize(tool, read.found, [...read.notes]);
  return { tool, title: read.title, ...result };
}
