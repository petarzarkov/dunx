import type { SwaggerAssets } from './swagger.js';
import type { OpenApiDocument } from './types.js';
import { renderUiOptions, type SwaggerUiOptions } from './ui-options.js';

/**
 * The page is a Swagger UI shell: its stylesheet, its bundle, the document
 * embedded as JSON, and one call to `SwaggerUIBundle`.
 *
 * **The stylesheet and the script are same-origin `<link>` and `<script src>`,
 * which is a change.** The old page inlined a bundle of dunx's own and fetched
 * nothing at all. Swagger UI is 3.7x the size gzipped, so inlining it would resend
 * 1.7 MiB on every page load; served as two assets with an immutable cache header
 * it is fetched once. Nothing reaches a CDN or any other host either way, which is
 * the half of that guarantee worth keeping and what `html.test.ts` asserts.
 *
 * The **document** is still embedded rather than fetched. Swagger UI's `url` option
 * would have it request the JSON route itself, which costs a round trip and makes
 * the page depend on that route staying reachable and unguarded; `spec` hands it the
 * bytes the server already has.
 *
 * **`color-scheme: light` is load bearing, and getting it wrong is what a first
 * draft of this file did.** Swagger UI ships one stylesheet and it is light-only.
 * Declaring `light dark` - which the old dunx explorer correctly did, because it had
 * a dark theme - tells the browser to paint dark defaults under it, and the result
 * on a dark-preference machine is a page with a black canvas, dark grey text on
 * black, and white bands wherever Swagger UI happens to set a background
 * explicitly. There is no dark Swagger UI to opt into.
 *
 * The `box-sizing` rules and the `#fafafa` background are Swagger UI's own
 * `index.css`, which is not part of `swagger-ui.css` and which its dist `index.html`
 * loads separately. Its layout assumes them.
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

const escape = (value: string): string => Bun.escapeHTML(value);

/**
 * `<` is the only character that can end the data block early, and escaping it as
 * `<` keeps the text valid JSON. The parser sees the same document either way.
 */
const embed = (value: unknown): string =>
  JSON.stringify(value).replaceAll('<', '\\u003c');

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
    `<title>${escape(title)}</title>` +
    `<link rel="stylesheet" href="${escape(style)}">` +
    (icon === false ? '' : `<link rel="icon" href="${escape(icon)}">`) +
    `<style>${BOOT}</style></head><body><div id="${MOUNT_ELEMENT_ID}"></div>` +
    '<noscript><p class="no-js">This API explorer needs JavaScript. ' +
    `The document itself is at <a href="${escape(options.jsonHref)}">` +
    `${escape(options.jsonHref)}</a>.</p></noscript>` +
    `<script type="application/json" id="${DOCUMENT_ELEMENT_ID}">` +
    `${embed(document)}</script>` +
    `<script src="${escape(script)}"></script>` +
    // `defer` is not enough on its own: the bundle defines `SwaggerUIBundle` as a
    // global, so this has to run after it and a plain trailing script does.
    // The options object carries `spec` last so a caller cannot replace the
    // embedded document with a `url` by accident, and `layout` defaults to
    // `BaseLayout`: the standalone one needs a second ~1 MiB preset file and all it
    // adds is a URL bar for loading other documents.
    '<script>(function(){' +
    `var node=document.getElementById(${embed(DOCUMENT_ELEMENT_ID)});` +
    `var options=${renderUiOptions({ layout: 'BaseLayout', ...ui }, MOUNT_ELEMENT_ID)};` +
    'options.spec=JSON.parse(node.textContent);' +
    'window.ui=SwaggerUIBundle(options);' +
    '})();</script>' +
    '</body></html>'
  );
};
