import type { CompressionEncoding } from './options.js';

/**
 * The q-value of one `accept-encoding` element, defaulting to 1.
 *
 * A malformed q is read as 1 rather than 0: `gzip;q=high` is a broken client
 * saying it wants gzip, and answering with an identity body is the safer reading
 * of it than refusing.
 */
const quality = (params: readonly string[]): number => {
  for (const param of params) {
    const [key, value] = param.split('=');
    if (key?.trim().toLowerCase() !== 'q') continue;
    const q = Number.parseFloat(value ?? '');
    return Number.isFinite(q) && q >= 0 && q <= 1 ? q : 1;
  }
  return 1;
};

/**
 * The coding to encode with, or `undefined` for none.
 *
 * `offered` is the server's preference order and breaks a tie, which is what
 * makes `['zstd', 'gzip']` meaningful against a browser that sends both at the
 * same q. An explicit `q=0` refuses a coding, `*` supplies a default for the ones
 * not named, and an absent header means the client said nothing - answered with
 * no encoding, because a client that cannot decode is worse than one that reads
 * a few more bytes.
 */
export const negotiate = (
  header: string | null,
  offered: readonly CompressionEncoding[],
): CompressionEncoding | undefined => {
  if (header === null) return undefined;

  const accepted = new Map<string, number>();
  for (const element of header.split(',')) {
    const [name, ...params] = element.split(';');
    const token = name?.trim().toLowerCase();
    if (token === undefined || token === '') continue;
    accepted.set(token, quality(params));
  }

  const wildcard = accepted.get('*');
  let best: CompressionEncoding | undefined;
  let bestQuality = 0;
  for (const encoding of offered) {
    const q = accepted.get(encoding) ?? wildcard ?? 0;
    if (q > bestQuality) {
      best = encoding;
      bestQuality = q;
    }
  }
  return best;
};
