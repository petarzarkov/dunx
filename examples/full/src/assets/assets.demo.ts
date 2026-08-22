import { Logger } from '@dunx/core';

/**
 * The two cache policies, and the traversal refusal.
 *
 * There is no `index.html` fallback and no SPA rewrite here, because `StaticFiles`
 * ships neither: building one in would mean the middleware deciding what a 404
 * means for paths it does not own.
 */
export class AssetsDemo {
  constructor(private readonly logger: Logger) {}

  async demonstrate(url: string): Promise<void> {
    for (const path of ['assets/site.css', 'assets/app.a1b2c3d4.js']) {
      const response = await fetch(new URL(path, url));
      this.logger.info(
        `GET /${path} -> ${response.status} ` +
          `${response.headers.get('content-type')}, ` +
          `cache-control: ${response.headers.get('cache-control')}`,
      );
      await response.arrayBuffer();
    }
    this.logger.info(
      'the hashed name is immutable, the plain one is max-age=60 - a content ' +
        'hash is the only honest reason to promise forever',
    );

    // Resolved against the root at construction, and checked on every request.
    const escaped = await fetch(new URL('assets/../../package.json', url));
    this.logger.info(
      `GET /assets/../../package.json -> ${escaped.status} (never leaves the root)`,
    );

    // Anything outside the mount falls straight through, so the app's own routes
    // and its 404 behave exactly as they did before this was registered.
    const through = await fetch(new URL('api/notes', url));
    this.logger.info(
      `GET /api/notes -> ${through.status} (outside /assets, untouched)`,
    );
  }
}
