import { Logger } from '@dunx/core';

/** Both versions of `/api/swatches`, and the headers the deprecated one sends. */
export class VersioningDemo {
  constructor(private readonly logger: Logger) {}

  async demonstrate(url: string): Promise<void> {
    const v1 = await fetch(new URL('api/v1/swatches', url));
    this.logger.info(
      `GET /api/v1/swatches -> ${v1.status} ${JSON.stringify(await v1.json())}`,
    );
    this.logger.info(
      `  Deprecation: ${v1.headers.get('deprecation')} | ` +
        `Sunset: ${v1.headers.get('sunset')}`,
    );

    const v2 = await fetch(new URL('api/v2/swatches', url));
    const [first] = (await v2.json()) as readonly unknown[];
    this.logger.info(
      `GET /api/v2/swatches -> ${v2.status}, first ${JSON.stringify(first)}, ` +
        `deprecated: ${v2.headers.has('deprecation')}`,
    );
  }
}
