import { PackageAssets, type AssetPackage } from '../assets.js';
import { DocsRenderer, type PageOptions } from '../renderer.js';
import type { OpenApiDocument } from '../types.js';
import { renderScalarPage } from './html.js';
import type { ScalarOptions } from './options.js';

/**
 * The files served out of `@scalar/api-reference`. The standalone build, not the
 * ESM one: that is smaller but lazy-loads ~180 chunks, which one asset route
 * cannot serve. The `.map` is here because the bundle's last line points at it.
 */
export const SCALAR_ASSETS: AssetPackage = Object.freeze({
  name: '@scalar/api-reference',
  directory: 'dist/browser',
  files: Object.freeze({
    'standalone.js': 'text/javascript; charset=utf-8',
    'standalone.js.map': 'application/json; charset=utf-8',
  }),
});

/**
 * Scalar, served from the consumer's own `@scalar/api-reference`.
 *
 * ```ts
 * OpenApiModule.forRoot({ root: AppModule, renderer: new ScalarRenderer() });
 * ```
 *
 * 1.05 MiB gzipped against Swagger UI's 447 KiB, and 276 MB across 279 packages
 * installed, which is why it is an optional peer behind its own subpath.
 */
export class ScalarRenderer extends DocsRenderer {
  readonly #options: ScalarOptions;

  constructor(options: ScalarOptions = {}) {
    super();
    this.#options = options;
  }

  async page(document: OpenApiDocument, options: PageOptions): Promise<string> {
    const assets = await PackageAssets.resolve(SCALAR_ASSETS);
    return renderScalarPage(document, options, assets, this.#options);
  }

  asset(name: string): Promise<Response> {
    return PackageAssets.serve(SCALAR_ASSETS, name);
  }
}
