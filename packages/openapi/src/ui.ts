import { renderShell, type PageOptions } from './html.js';
import type { OpenApiDocument } from './types.js';
import { FAVICON, UI } from './ui-bundle.js';

/**
 * The explorer, behind its own entrypoint.
 *
 * `ui-bundle.ts` is ~456 KB of inlined Vite output and importing it costs about
 * 5 ms. Every consumer of `@dunx/openapi` used to pay that at boot, because
 * `html.ts` imported it statically and `index.ts` re-exported the renderer, so a
 * service that never opens `/docs` still loaded a React app. Splitting it here
 * means `OpenApiModule` can `await import('./ui.js')` on the first request for
 * the page and nowhere else.
 *
 * This is `@dunx/openapi/ui` in the manifest, and it is an entrypoint rather
 * than a plain module so the build emits it as its own file - see
 * `scripts/build-package.ts`, which derives entrypoints from `exports`.
 */
export const renderPage = (
  document: OpenApiDocument,
  options: PageOptions,
): string => renderShell(document, options, UI, FAVICON);

export { FAVICON, UI };
export { MODEL_ELEMENT_ID, renderShell, type PageOptions } from './html.js';
