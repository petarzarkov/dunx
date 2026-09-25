import { Logger } from '@dunx/core';

const COLORS = 'api/colors';

/** `etag: true` in `main.ts`: a tag on a returned value, and the 304 it earns. */
export class EtagDemo {
  constructor(private readonly logger: Logger) {}

  async demonstrate(url: string): Promise<void> {
    const first = await fetch(new URL(COLORS, url));
    const bytes = (await first.bytes()).byteLength;
    const etag = first.headers.get('etag');
    this.logger.info(
      `GET /${COLORS} -> ${first.status}, ${bytes} bytes, ETag ${etag}`,
    );
    if (etag === null) return;

    const again = await fetch(new URL(COLORS, url), {
      headers: { 'if-none-match': etag },
    });
    const body = (await again.bytes()).byteLength;
    this.logger.info(
      `If-None-Match: ${etag} -> ${again.status}, ${body} bytes, ` +
        `vary: ${again.headers.get('vary') ?? '-'}`,
    );

    const stale = await fetch(new URL(COLORS, url), {
      headers: { 'if-none-match': 'W/"0000000000000000"' },
    });
    await stale.body?.cancel();
    this.logger.info(`a tag the server did not send -> ${stale.status}`);
  }
}
