import { renderShell } from './html.js';
import type { DashboardOptions } from './options.js';
import { FAVICON, UI } from './ui-bundle.js';

/**
 * The page, behind its own entrypoint.
 *
 * `ui-bundle.ts` is the inlined Vite output, and importing it costs a few
 * milliseconds and its full size in parsed source. `DashboardMiddleware` reaches
 * this with `await import('./ui.js')` on the **first request for the page**, so an
 * app that mounts the module and never opens it - a worker process, a service
 * whose dashboard nobody visits this week - pays nothing at boot.
 *
 * `html.ts` therefore must not import `ui-bundle.ts`, or the split silently
 * reverts. It takes the bundle as an argument for exactly that reason.
 *
 * This is `@dunx/dashboard/ui` in the manifest, and it is an entrypoint rather than
 * a plain module so the build emits it as its own file - see
 * `scripts/build-package.ts`, which derives entrypoints from `exports`.
 */
export const renderPage = (options: DashboardOptions): string =>
  renderShell(options, UI, FAVICON);

export { FAVICON, UI };
export { META_ELEMENT_ID, renderShell } from './html.js';
