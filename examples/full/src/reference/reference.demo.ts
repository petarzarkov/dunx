import { Logger } from '@dunx/core';
import { REFERENCE_PATH } from './reference.middleware.js';

export class ReferenceDemo {
  constructor(private readonly logger: Logger) {}

  /**
   * The same document as `/api/docs`, rendered by the other renderer dunx ships.
   * Both self-host: the page links one file, served from the install.
   */
  async demonstrate(url: string): Promise<void> {
    const { logger } = this;
    const page = await fetch(new URL(REFERENCE_PATH.slice(1), url));
    const html = await page.text();

    logger.info(
      `GET ${REFERENCE_PATH} -> ${page.status} ${page.headers.get('content-type')}, ` +
        `${html.length} bytes of Scalar shell`,
    );

    const shell = html.replace(/(<script[^>]*>)[\s\S]*?(<\/script>)/g, '$1$2');
    const requested = [
      ...shell.matchAll(/<(?:script|link)\b[^>]*\s(?:src|href)="([^"]*)"/g),
    ]
      .map(([, href]) => href ?? '')
      .filter((href) => !href.startsWith('data:'));
    const offOrigin = requested.filter((href) => /^[a-z]+:|^\/\//i.test(href));
    logger.info(
      `  requests ${requested.length} asset(s), ${offOrigin.length} off-origin: ` +
        JSON.stringify(requested),
    );

    for (const href of requested) {
      const asset = await fetch(new URL(href.replace(/^\//, ''), url));
      logger.info(
        `  ${href.split('?')[0]} -> ${asset.status} ` +
          `${asset.headers.get('content-type')}, ` +
          `${Number(asset.headers.get('content-length') ?? 0).toLocaleString('en-US')} bytes, ` +
          `cache-control: ${asset.headers.get('cache-control')}`,
      );
    }

    // The allow-list is the renderer's, so the other builds beside it on disk are
    // a 404 rather than a read out of node_modules.
    const off = await fetch(
      new URL(`${REFERENCE_PATH.slice(1)}/package.json`, url),
    );
    logger.info(`  ${REFERENCE_PATH}/package.json -> ${off.status}`);
  }
}
