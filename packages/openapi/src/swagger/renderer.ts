import { PackageAssets, type AssetPackage } from '../assets.js';
import { DocsRenderer, type PageOptions } from '../renderer.js';
import type { OpenApiDocument } from '../types.js';
import { renderSwaggerPage } from './html.js';
import type { SwaggerUiOptions } from './options.js';

/**
 * The files served out of `swagger-ui-dist`, which holds four other builds and
 * 4 MB of sourcemaps beside them. The `.css.map` is here because the stylesheet
 * points at it, and without it devtools logs a 404.
 */
export const SWAGGER_ASSETS: AssetPackage = Object.freeze({
  name: 'swagger-ui-dist',
  files: Object.freeze({
    'swagger-ui-bundle.js': 'text/javascript; charset=utf-8',
    'swagger-ui.css': 'text/css; charset=utf-8',
    'swagger-ui.css.map': 'application/json; charset=utf-8',
    'favicon-32x32.png': 'image/png',
  }),
});

/**
 * Swagger UI, served from the consumer's own `swagger-ui-dist`.
 *
 * ```ts
 * OpenApiModule.forRoot({ root: AppModule, renderer: new SwaggerRenderer() });
 * ```
 *
 * 1.7 MiB of assets, 447 KiB gzipped. The install is 12 MB across 2 packages.
 */
export class SwaggerRenderer extends DocsRenderer {
  readonly #ui: SwaggerUiOptions;

  constructor(ui: SwaggerUiOptions = {}) {
    super();
    this.#ui = ui;
  }

  async page(document: OpenApiDocument, options: PageOptions): Promise<string> {
    const assets = await PackageAssets.resolve(SWAGGER_ASSETS);
    return renderSwaggerPage(document, options, assets, this.#ui);
  }

  asset(name: string): Promise<Response> {
    return PackageAssets.serve(SWAGGER_ASSETS, name);
  }
}
