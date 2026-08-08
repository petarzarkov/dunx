import { Logger, type ModuleRef } from '@dunx/core';
import type { Middleware, Next, RouteContext } from '@dunx/http';
import type { BunRequest } from 'bun';
import { buildBoard, type Board } from './board.js';
import { DashboardOptions } from './options.js';
import { handleDashboard, type RouterDeps } from './router.js';

/**
 * A **global middleware**, not a controller, and that is not a stylistic choice.
 *
 * Middleware registered with `app.use` runs in front of the unmatched-path
 * fallback, which is exactly where the dashboard's paths land because the app
 * declares none of them. Declaring them as dunx routes would mean generating
 * controllers for a route table handed over at runtime, and every panel would need
 * its own `@Get`.
 *
 * Two consequences of that, both learned the hard way and both worth keeping:
 *
 * - **Register it ahead of any session guard.** Measured in `dunx-template`: with
 *   this last in the chain, `SessionGuard` answered every dashboard request `401`
 *   before `authorize` ran, which defeats the 404 contract entirely. That works
 *   only because `authorize` gets the raw `Request` and can ask the auth library
 *   itself, so keep it self-sufficient.
 * - **Anything outside the mount falls through untouched**, so the app's own
 *   routes and its 404 behave exactly as before.
 *
 * The page bundle is built on the **first request** and memoised on the promise,
 * so two concurrent first requests build one page and importing this package pulls
 * in none of its 400-odd KB.
 */
export class DashboardMiddleware implements Middleware {
  readonly #options: DashboardOptions;
  readonly #deps: RouterDeps;
  readonly #prefix: string;
  #page: Promise<string> | undefined;
  #board: Promise<Board> | undefined;

  constructor(options: DashboardOptions, root: ModuleRef, logger: Logger) {
    this.#options = options;
    // With the trailing slash, so `/_dunxious` cannot match a `/_dunx` mount. The
    // bare mount is matched separately.
    this.#prefix = `${options.path}/`;
    this.#deps = {
      root,
      options,
      startedAt: performance.now(),
      page: () => this.#renderPage(),
      board: () => this.#buildBoard(),
    };

    if (options.authorize === undefined) {
      logger.warn(
        `The dashboard at ${options.path} has no authorize function, so it is ` +
          'served to anyone who can reach this port - including the route table, ' +
          'the provider graph and the config keys. Pass ' +
          'DashboardModule.forRoot({ authorize }) unless this port is private.',
      );
    }
  }

  async handle(
    req: BunRequest,
    _ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    if (pathname !== this.#options.path && !pathname.startsWith(this.#prefix)) {
      return next();
    }

    // 404, never 403. A dashboard that announces itself to an unauthenticated
    // caller has told them where to keep knocking - so a rejected request is
    // indistinguishable from a mount that is not there.
    if (this.#options.authorize && !(await this.#options.authorize(req))) {
      return Response.json(
        { error: 'NOT_FOUND', status: 404 },
        { status: 404 },
      );
    }

    const rest = pathname.slice(this.#options.path.length);
    return handleDashboard(this.#deps, req, rest);
  }

  /**
   * bull-board, built on the **first request for the queues page** and memoised on
   * the promise.
   *
   * Lazily, because building it calls `QueueSource.queue(name)` for every queue,
   * and that opens a connection to the broker. An app that mounts the dashboard and
   * never opens the queues page must not hold a socket for it - which is also what
   * lets a process exit cleanly against an absent Redis.
   */
  #buildBoard(): Promise<Board> {
    // The favicon comes out of the same lazily-imported module as the page
    // bundle, so bull-board wears the dunx mark without this file loading 400 KB
    // to find out what it is.
    this.#board ??= import('./ui.js').then(({ FAVICON }) =>
      buildBoard(this.#options, `${this.#options.path}/queues`, FAVICON),
    );
    return this.#board;
  }

  /**
   * The bundle lives behind `@dunx/dashboard/ui` and is reached with a dynamic
   * import, so an app that never opens the page never parses it. The **promise** is
   * memoised rather than the string, which is what makes two concurrent first
   * requests build one page.
   */
  #renderPage(): Promise<string> {
    this.#page ??= import('./ui.js').then(({ renderPage }) =>
      renderPage(this.#options),
    );
    return this.#page;
  }
}
