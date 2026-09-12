import { PackageAssets, type AssetPackage } from '../assets.js';
import { DocsRenderer, type PageOptions } from '../renderer.js';
import type { OpenApiDocument } from '../types.js';
import { renderScalarPage } from './html.js';
import type { ScalarOptions } from './options.js';

/**
 * The files served out of `@scalar/api-reference`.
 *
 * The standalone build, not the ESM one: the ESM entry is smaller but lazy-loads
 * ~180 chunks, which one asset route cannot serve. `standalone.js.map` is here
 * because the bundle's last line points at it, so without it every consumer with
 * devtools open logs a 404.
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
 * OpenApiModule.forRoot({
 *   title: 'Payments',
 *   version: '1.4.0',
 *   root: AppModule,
 *   renderer: new ScalarRenderer({ theme: 'purple' }),
 * });
 * ```
 *
 * 3.7 MiB of assets, 1.05 MiB gzipped, against Swagger UI's 447 KiB. The install
 * is 276 MB across 279 packages, which is why it is an optional peer and why the
 * subpath exists at all.
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
