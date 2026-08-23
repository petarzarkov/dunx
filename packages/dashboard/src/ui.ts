import { renderShell } from './html.js';
import type { DashboardOptions } from './options.js';
import { FAVICON, UI } from './ui-bundle.js';

/**
 * The page, behind its own entrypoint. `ui-bundle.ts` is the inlined Vite output,
 * reached with `await import('./ui.js')` on the first request for the page, so an
 * app that mounts the module and never opens it pays nothing at boot.
 *
 * `html.ts` must not import `ui-bundle.ts`, or the split silently reverts; it
 * takes the bundle as an argument for that reason.
 *
 * `@dunx/dashboard/ui` in the manifest, so the build emits it as its own file.
 */
export const renderPage = (options: DashboardOptions): string =>
  renderShell(options, UI, FAVICON);

export { FAVICON, UI };
export { META_ELEMENT_ID, renderShell } from './html.js';
