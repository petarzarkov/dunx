import type { SwaggerAssets } from './swagger.js';
import type { OpenApiDocument } from './types.js';
import { renderUiOptions, type SwaggerUiOptions } from './ui-options.js';
import { embedJson } from '@dunx/http/internal';

/**
 * A Swagger UI shell: its stylesheet, its bundle, the document embedded as JSON,
 * and one call to `SwaggerUIBundle`.
 *
 * The stylesheet and script are same-origin `<link>` and `<script src>` rather
 * than inlined - Swagger UI is 1.7 MiB, so inlining would resend it on every load.
 * Nothing reaches a CDN either way, which `html.test.ts` asserts.
 *
 * The document is embedded rather than fetched: `url` would cost a round trip and
 * make the page depend on that route staying reachable and unguarded.
 *
 * `color-scheme: light` is load bearing: Swagger UI ships one light-only
 * stylesheet, so `light dark` paints dark defaults under it. The `box-sizing`
 * rules and `#fafafa` are its own `index.css`, which its layout assumes.
 */
const BOOT = `
:root { color-scheme: light; }
html { box-sizing: border-box; }
*, *:before, *:after { box-sizing: inherit; }
html, body { margin: 0; padding: 0; background: #fafafa; }
#swagger-ui:empty::after {
  content: 'Loading the API explorer\\2026';
  display: block; padding: 3rem 1.5rem; text-align: center; opacity: .6;
  font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}
.no-js { padding: 3rem 1.5rem; text-align: center;
  font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; }
`;

export interface PageOptions {
  /** Where the JSON document is served, so the page can link to it. */
  readonly jsonHref: string;
  readonly warnings: readonly string[];
  /** Where the page itself is mounted, which is where its assets hang off. */
  readonly mountedAt: string;
  /** Everything Swagger UI takes, plus the favicon and title dunx owns. */
  readonly ui?: SwaggerUiOptions;
}

/** The id the page reads its document from. */
export const DOCUMENT_ELEMENT_ID = 'dunx-openapi-document';

/** The element Swagger UI mounts into. */
export const MOUNT_ELEMENT_ID = 'swagger-ui';

export const renderShell = (
  document: OpenApiDocument,
  options: PageOptions,
  assets: SwaggerAssets,
): string => {
  const ui = options.ui ?? {};
  const title = ui.title ?? `${document.info.title} ${document.info.version}`;
  const style = assets.href(options.mountedAt, 'swagger-ui.css');
  const script = assets.href(options.mountedAt, 'swagger-ui-bundle.js');
  // Swagger UI's own mark, from the same install. Without a favicon of some kind a
  // browser asks for `/favicon.ico` and every consumer logs a 404 against their own
  // app, which is why the default is a real file rather than nothing.
  const icon =
    ui.favicon === undefined
      ? assets.href(options.mountedAt, 'favicon-32x32.png')
      : ui.favicon;

  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${Bun.escapeHTML(title)}</title>` +
    `<link rel="stylesheet" href="${Bun.escapeHTML(style)}">` +
    (icon === false ? '' : `<link rel="icon" href="${Bun.escapeHTML(icon)}">`) +
    `<style>${BOOT}</style></head><body><div id="${MOUNT_ELEMENT_ID}"></div>` +
    '<noscript><p class="no-js">This API explorer needs JavaScript. ' +
    `The document itself is at <a href="${Bun.escapeHTML(options.jsonHref)}">` +
    `${Bun.escapeHTML(options.jsonHref)}</a>.</p></noscript>` +
    `<script type="application/json" id="${DOCUMENT_ELEMENT_ID}">` +
    `${embedJson(document)}</script>` +
    `<script src="${Bun.escapeHTML(script)}"></script>` +
    // `defer` is not enough on its own: the bundle defines `SwaggerUIBundle` as a
    // global, so this has to run after it and a plain trailing script does.
    // The options object carries `spec` last so a caller cannot replace the
    // embedded document with a `url` by accident, and `layout` defaults to
    // `BaseLayout`: the standalone one needs a second ~1 MiB preset file and all it
    // adds is a URL bar for loading other documents.
    '<script>(function(){' +
    `var node=document.getElementById(${embedJson(DOCUMENT_ELEMENT_ID)});` +
    `var options=${renderUiOptions({ layout: 'BaseLayout', ...ui }, MOUNT_ELEMENT_ID)};` +
    'options.spec=JSON.parse(node.textContent);' +
    'window.ui=SwaggerUIBundle(options);' +
    '})();</script>' +
    '</body></html>'
  );
};
