import type { PackageAssets } from '../assets.js';
import type { PageOptions } from '../renderer.js';
import { readDocument, renderShell } from '../shell.js';
import type { OpenApiDocument } from '../types.js';
import { renderUiOptions, type SwaggerUiOptions } from './options.js';

/**
 * `color-scheme: light` is load bearing: Swagger UI ships one light-only
 * stylesheet, so `light dark` paints dark defaults under it. `#fafafa` is its own
 * `index.css`, which its layout assumes.
 */
const SWAGGER_CSS = `
:root { color-scheme: light; }
html, body { background: #fafafa; }
`;

/** The element Swagger UI mounts into. */
export const MOUNT_ELEMENT_ID = 'swagger-ui';

/**
 * A Swagger UI shell: its stylesheet, its bundle, the document embedded as JSON,
 * and one call to `SwaggerUIBundle`.
 */
export const renderSwaggerPage = (
  document: OpenApiDocument,
  options: PageOptions,
  assets: PackageAssets,
  ui: SwaggerUiOptions = {},
): string =>
  renderShell(document, {
    mountId: MOUNT_ELEMENT_ID,
    css: SWAGGER_CSS,
    jsonHref: options.jsonHref,
    ...(ui.title === undefined ? {} : { title: ui.title }),
    // Swagger UI's own mark, from the same install. Without a favicon of some
    // kind a browser asks for `/favicon.ico` and every consumer logs a 404
    // against their own app.
    icon:
      ui.favicon === undefined
        ? assets.href(options.mountedAt, 'favicon-32x32.png')
        : ui.favicon,
    styles: [assets.href(options.mountedAt, 'swagger-ui.css')],
    scripts: [assets.href(options.mountedAt, 'swagger-ui-bundle.js')],
    // The options object carries `spec` last so a caller cannot replace the
    // embedded document with a `url` by accident, and `layout` defaults to
    // `BaseLayout`: the standalone one needs a second ~1 MiB preset file and all
    // it adds is a URL bar for loading other documents.
    boot:
      '(function(){' +
      readDocument('spec') +
      `var options=${renderUiOptions({ layout: 'BaseLayout', ...ui }, MOUNT_ELEMENT_ID)};` +
      'options.spec=spec;' +
      'window.ui=SwaggerUIBundle(options);' +
      '})();',
  });
