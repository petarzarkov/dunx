import { metaOf } from './api/snapshot.js';
import type { DashboardOptions } from './options.js';

/**
 * The page is a shell: a boot stylesheet, the mount's metadata as JSON, and the
 * bundle inlined. Nothing is fetched to start up, so the dashboard works on a host
 * with no egress.
 *
 * The bundle arrives as an argument rather than an import: `./ui.js` pairs the two
 * lazily on the first page request, and importing it here would put 400-odd KB in
 * every app that mounts the module.
 *
 * Only the meta is embedded; routes, queues and the runtime are fetched, since a
 * queue count in the HTML would be stale before it painted.
 */
const BOOT = `
:root { color-scheme: light dark; }
html, body { margin: 0; padding: 0; background: #fff; }
@media (prefers-color-scheme: dark) { html, body { background: #242424; } }
#root:empty::after {
  content: 'Loading\\2026';
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

/** The id the bundle reads its meta from. Shared with `internal/dashboard-ui`. */
export const META_ELEMENT_ID = 'dunx-dashboard-meta';

export const renderShell = (
  options: DashboardOptions,
  ui: string,
  favicon: string,
): string => {
  const title = `${options.title} dashboard`;

  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    // The page lists routes, providers and config keys. Nothing about it should
    // reach a search index or a referrer log if it is ever exposed by mistake.
    '<meta name="robots" content="noindex, nofollow">' +
    '<meta name="referrer" content="no-referrer">' +
    `<title>${escape(title)}</title>` +
    // A `data:` URI, so the tab icon costs no request either. Same mark as the
    // documentation site and the API explorer - `@dunx/ui` declares it once and
    // the bundle build emits it next to the script.
    `<link rel="icon" type="image/svg+xml" href="${escape(favicon)}">` +
    `<style>${BOOT}</style></head><body><div id="root"></div>` +
    '<noscript><p class="no-js">This dashboard needs JavaScript. Every panel ' +
    `also answers as JSON under <code>${escape(options.path)}/api</code>.</p></noscript>` +
    `<script type="application/json" id="${META_ELEMENT_ID}">` +
    `${embed(metaOf(options))}</script>` +
    `<script>${ui}</script></body></html>`
  );
};
