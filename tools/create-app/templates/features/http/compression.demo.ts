import { Logger } from '@dunx/core';

const DOCUMENT = 'api/openapi.json';
/** Under the 1024-byte threshold, so it is sent as it is. */
const SMALL = 'api/notes/whoami';

interface Measured {
  readonly encoding: string;
  readonly wire: number;
  readonly decoded: number;
  readonly vary: string;
}

/** `fetch` decodes the body but leaves `content-encoding` and the encoded
 * `content-length`, so one request measures both sides. */
const measure = async (
  url: string,
  path: string,
  accept: string,
): Promise<Measured> => {
  const response = await fetch(new URL(path, url), {
    headers: { 'accept-encoding': accept },
  });
  const decoded = await response.text();
  const wire = response.headers.get('content-length');
  return {
    encoding: response.headers.get('content-encoding') ?? 'identity',
    wire: wire === null ? decoded.length : Number(wire),
    decoded: decoded.length,
    vary: response.headers.get('vary') ?? '-',
  };
};

const ratio = (m: Measured): string =>
  `${((m.wire / m.decoded) * 100).toFixed(1)}%`;

export class CompressionDemo {
  constructor(private readonly logger: Logger) {}

  async demonstrate(url: string): Promise<void> {
    const { logger } = this;

    // Vendored by `@dunx/create-app`: a scaffold taking `http` without `openapi`
    // has no document to encode.
    const available = await fetch(new URL(DOCUMENT, url));
    await available.body?.cancel();
    if (!available.ok) {
      logger.info(`skipping: no ${DOCUMENT} in this app to encode`);
      return;
    }

    // `identity` is a coding the app does not offer, so nothing is picked.
    for (const accept of ['identity', 'gzip', 'zstd', 'gzip, zstd']) {
      const m = await measure(url, DOCUMENT, accept);
      logger.info(
        `accept-encoding: ${accept.padEnd(11)} -> ${m.encoding.padEnd(8)} ` +
          `${String(m.wire).padStart(6)} of ${m.decoded} bytes (${ratio(m)})`,
      );
    }

    // Same q, so the server's order decides: `['zstd', 'gzip']`.
    const preferred = await measure(url, DOCUMENT, 'gzip, zstd');
    logger.info(
      `a tie in the client's q-values is broken by the server order -> ${preferred.encoding}`,
    );

    const forced = await measure(url, DOCUMENT, 'zstd;q=0.1, gzip;q=0.9');
    logger.info(`zstd;q=0.1, gzip;q=0.9 -> ${forced.encoding}`);

    const small = await measure(url, SMALL, 'gzip, zstd');
    logger.info(
      `under the 1024-byte threshold: ${SMALL} -> ${small.encoding} ` +
        `(${small.decoded} bytes, encoding it would add bytes)`,
    );
    logger.info(
      `vary: ${small.vary} - set even when nothing was encoded, so a shared ` +
        `cache does not serve one client's encoding to another`,
    );
  }
}
