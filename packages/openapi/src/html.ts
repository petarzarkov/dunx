import { buildModel } from './model.js';
import type { OpenApiDocument } from './types.js';

/**
 * The page is a shell: a boot stylesheet, the model as JSON, and the explorer
 * bundle inlined. Nothing is fetched - no CDN, no `src=`, no `<link>` - which is
 * the guarantee `html.test.ts` asserts and the reason `swagger-ui-dist` (11.7 MB,
 * and a CDN in practice) was never an option.
 *
 * The UI itself is a real frontend: `internal/openapi-ui`, Vite + Mantine, built and
 * written into `ui-bundle.ts`. Serving the built output rather than hand-written
 * markup is what let the page grow disclosure controls, an auth dialog and a
 * schema renderer without any of that landing in a backend package.
 *
 * That bundle arrives as an **argument**, not an import, which is what keeps this
 * module cheap: `./ui.js` is the entrypoint that pairs the two, and it is loaded
 * lazily. See `renderPage` there.
 */
const BOOT = `
:root { color-scheme: light dark; }
html, body { margin: 0; padding: 0; background: #fff; }
@media (prefers-color-scheme: dark) { html, body { background: #242424; } }
#root:empty::after {
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
const embed = (model: unknown): string =>
  JSON.stringify(model).replaceAll('<', '\\u003c');

export interface PageOptions {
  /** Where the JSON document is served, so the page can link to it. */
  readonly jsonHref: string;
  readonly warnings: readonly string[];
}

/** The id the bundle reads its model from. Shared with `internal/openapi-ui`. */
export const MODEL_ELEMENT_ID = 'dunx-openapi-model';

export const renderShell = (
  document: OpenApiDocument,
  options: PageOptions,
  ui: string,
  favicon: string,
): string => {
  const title = `${document.info.title} ${document.info.version}`;

  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escape(title)}</title>` +
    // A `data:` URI, so the tab icon costs no request either - the page's whole
    // guarantee is that it fetches nothing. Same mark as the documentation site
    // and the dashboard; `@dunx/ui` declares it once and the bundle build emits
    // it next to the script.
    `<link rel="icon" type="image/svg+xml" href="${escape(favicon)}">` +
    `<style>${BOOT}</style></head><body><div id="root"></div>` +
    '<noscript><p class="no-js">This API explorer needs JavaScript. ' +
    `The document itself is at <a href="${escape(options.jsonHref)}">` +
    `${escape(options.jsonHref)}</a>.</p></noscript>` +
    `<script type="application/json" id="${MODEL_ELEMENT_ID}">` +
    `${embed(buildModel(document, options))}</script>` +
    `<script>${ui}</script></body></html>`
  );
};
