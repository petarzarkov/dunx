import { embedJson } from '@dunx/http/internal';
import type { OpenApiDocument } from './types.js';

/** The id every renderer reads its document from. */
export const DOCUMENT_ELEMENT_ID = 'dunx-openapi-document';

/**
 * The two keys a renderer's options carry for the shell rather than for its
 * library, so each of them strips exactly these before handing the rest over.
 */
export const SHELL_KEYS = Object.freeze(['favicon', 'title'] as const);

export interface ShellParts {
  /** The element the renderer mounts into. */
  readonly mountId: string;
  /** Stylesheet hrefs, in order. */
  readonly styles?: readonly string[];
  /** Script srcs, loaded in order before {@link ShellParts.boot} runs. */
  readonly scripts: readonly string[];
  /** The boot script body, as source. */
  readonly boot: string;
  /** Rules appended to the shell's own. */
  readonly css?: string;
  /** The `<title>`. Defaults to the document's own title and version. */
  readonly title?: string;
  /** The tab icon, or `false` for none. */
  readonly icon?: string | false;
  /** Where the JSON document is served, so `<noscript>` can link to it. */
  readonly jsonHref: string;
}

const baseCss = (mountId: string): string => `
html { box-sizing: border-box; }
*, *:before, *:after { box-sizing: inherit; }
html, body { margin: 0; padding: 0; }
#${mountId}:empty::after {
  content: 'Loading the API explorer\\2026';
  display: block; padding: 3rem 1.5rem; text-align: center; opacity: .6;
  font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}
.no-js { padding: 3rem 1.5rem; text-align: center;
  font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; }
`;

/**
 * The page every renderer produces: its stylesheets, its scripts, the document
 * embedded as JSON, and one boot script that reads the document back out.
 *
 * Scripts and styles are same-origin `<script src>` and `<link>` rather than
 * inlined, so a bundle measured in megabytes is fetched once and cached rather
 * than resent with every page load. Nothing reaches a CDN either way, which
 * each renderer's own tests assert.
 *
 * The document is embedded rather than fetched: a `url` would cost a round trip
 * and make the page depend on the JSON route staying reachable and unguarded.
 */
export const renderShell = (
  document: OpenApiDocument,
  parts: ShellParts,
): string => {
  const title =
    parts.title ?? `${document.info.title} ${document.info.version}`;
  const icon = parts.icon ?? false;

  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${Bun.escapeHTML(title)}</title>` +
    (parts.styles ?? [])
      .map((href) => `<link rel="stylesheet" href="${Bun.escapeHTML(href)}">`)
      .join('') +
    (icon === false ? '' : `<link rel="icon" href="${Bun.escapeHTML(icon)}">`) +
    `<style>${baseCss(parts.mountId)}${parts.css ?? ''}</style></head>` +
    `<body><div id="${parts.mountId}"></div>` +
    '<noscript><p class="no-js">This API explorer needs JavaScript. ' +
    `The document itself is at <a href="${Bun.escapeHTML(parts.jsonHref)}">` +
    `${Bun.escapeHTML(parts.jsonHref)}</a>.</p></noscript>` +
    `<script type="application/json" id="${DOCUMENT_ELEMENT_ID}">` +
    `${embedJson(document)}</script>` +
    parts.scripts
      .map((src) => `<script src="${Bun.escapeHTML(src)}"></script>`)
      .join('') +
    // A trailing script rather than `defer`: each bundle defines its entry point
    // as a global, so this has to run after the last one has executed.
    `<script>${parts.boot}</script></body></html>`
  );
};

/** The statement each boot script starts with, reading the embedded document. */
export const readDocument = (name: string): string =>
  `var ${name}=JSON.parse(document.getElementById(${embedJson(DOCUMENT_ELEMENT_ID)}).textContent);`;
