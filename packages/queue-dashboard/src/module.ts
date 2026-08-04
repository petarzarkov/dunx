import {
  provide,
  token,
  type Deps,
  type DynamicModule,
  type FactoryProvider,
} from '@dunx/core';
import { BunServeAdapter } from './adapter.js';
import { ejsRenderer, loadBullBoard } from './render.js';

/**
 * A bullmq `Queue`, restated structurally rather than imported.
 *
 * This package depends on `@dunx/infra` **not at all**, the same way `@dunx/auth`
 * restates `DbConnection` as `DrizzleSource`: `@dunx/infra` must not depend on the
 * web layer, and this must, so a dependency either way would invert that. What
 * bull-board needs from a queue is what `BullMQAdapter` reads off it, so anything
 * with a name and bullmq's client fits - including the queues
 * `@dunx/infra/queue` builds.
 */
export interface DashboardQueue {
  readonly name: string;
}

export interface QueueDashboardInit {
  /** Where the board is mounted. @default '/queues' */
  readonly path?: string;
  /**
   * The queues to show, or a function returning them.
   *
   * **Prefer the function.** A bullmq `Queue` opens a connection when it is
   * constructed, so naming the queues eagerly makes an app that mounts a dashboard
   * pay for a broker connection at boot - measured: it broke `examples/full`'s
   * "exits 0 with no redis" test, because `JobPublisher.queue()` in a factory
   * connects there and then. A thunk is called when the board is first requested,
   * which is the same point everything else here is loaded.
   */
  readonly queues:
    | readonly DashboardQueue[]
    | (() => readonly DashboardQueue[]);
  /** bull-board's own UI options - board title, logo, favicon. */
  readonly uiConfig?: Record<string, unknown>;
  /**
   * Called for every dashboard request before anything is served. Return false and
   * the request gets a 404, not a 403: a queue dashboard that announces itself to
   * an unauthenticated caller has told them where to keep knocking.
   *
   * A function rather than a `Ctor<Middleware>` list, because `app.use` is global -
   * middleware registered there runs for every route, and the point here is a check
   * that runs for these paths only.
   *
   * **There is no default.** Leaving it out serves the board to anyone who can
   * reach the port, which is a reasonable choice behind a private network and a bad
   * one otherwise, so it has to be stated either way.
   */
  readonly authorize?: (request: Request) => boolean | Promise<boolean>;
}

export class QueueDashboardOptions {
  readonly path: string;
  /** Always a thunk internally, so the build path has one shape to handle. */
  readonly queues: () => readonly DashboardQueue[];
  readonly uiConfig: Record<string, unknown>;
  readonly authorize:
    | ((request: Request) => boolean | Promise<boolean>)
    | undefined;

  constructor(init: QueueDashboardInit) {
    const path = init.path ?? '/queues';
    this.path = path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path;
    const { queues } = init;
    this.queues = typeof queues === 'function' ? queues : () => queues;
    this.uiConfig = init.uiConfig ?? {};
    this.authorize = init.authorize;
  }
}

/**
 * The board, built once and reused. Everything it needs - the adapter, the ejs
 * renderer, bull-board itself - is loaded on the first request rather than at boot,
 * so an app that mounts the module but never opens the page pays for none of it, and
 * a missing optional peer surfaces as a request failure naming what to install
 * rather than a boot crash.
 */
export class QueueDashboard {
  #adapter: Promise<BunServeAdapter> | undefined;

  constructor(private readonly options: QueueDashboardOptions) {}

  get path(): string {
    return this.options.path;
  }

  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const base = this.options.path;
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) {
      return undefined;
    }

    const { authorize } = this.options;
    if (authorize !== undefined && !(await authorize(request))) {
      return new Response('Not Found', { status: 404 });
    }

    return (await this.#build()).handle(request);
  }

  #build(): Promise<BunServeAdapter> {
    // Memoised on the promise, not the result, so two concurrent first requests
    // build one board rather than racing to build two.
    this.#adapter ??= (async (): Promise<BunServeAdapter> => {
      const [{ createBullBoard, BullMQAdapter, uiPath }, render] =
        await Promise.all([loadBullBoard(), ejsRenderer()]);

      const adapter = new BunServeAdapter(this.options.path, render);
      createBullBoard({
        queues: this.options.queues().map((queue) => new BullMQAdapter(queue)),
        serverAdapter: adapter,
        options: { uiConfig: this.options.uiConfig },
      });
      // bull-board resolves its own view and static paths relative to its `ui`
      // package, which it cannot find from here - so they are set after.
      adapter.setViewsPath(uiPath);
      adapter.setStaticPath('/static', `${uiPath}/static`);
      return adapter;
    })();

    return this.#adapter;
  }
}

export const QUEUE_DASHBOARD = token<QueueDashboard>('QueueDashboard');

/**
 * Mounts bull-board on a dunx app.
 *
 * Its own package rather than `@dunx/infra/queue`, for the reason `@dunx/auth` is:
 * serving a dashboard needs the web layer, and `@dunx/infra` must not depend on it.
 *
 * ```ts
 * imports: [
 *   QueueDashboardModule.forRootAsync({
 *     useFactory: (publisher: QueuePublisher) => ({
 *       queues: [publisher.queue('emails')],
 *       authorize: (request) => isAdmin(request),
 *     }),
 *     inject: [QueuePublisher],
 *   }),
 * ]
 * ```
 *
 * Then, between `create()` and `listen()`:
 *
 * ```ts
 * app.use(QueueDashboardMiddleware);
 * ```
 */
export class QueueDashboardModule {
  static forRoot(init: QueueDashboardInit): DynamicModule {
    return {
      module: QueueDashboardModule,
      providers: [
        provide(QueueDashboardOptions, {
          useValue: new QueueDashboardOptions(init),
        }),
        dashboardProvider(),
      ],
    };
  }

  /**
   * `forRoot` with the queues behind a factory, which is the case that matters here:
   * the queues live in the container, so they cannot be named in a static call.
   */
  static forRootAsync<const D extends Deps>(
    config: FactoryProvider<QueueDashboardInit, D>,
  ): DynamicModule {
    return {
      module: QueueDashboardModule,
      providers: [
        provide(QueueDashboardOptions, {
          useFactory: async (...deps: readonly unknown[]) =>
            new QueueDashboardOptions(
              await config.useFactory(...(deps as never)),
            ),
          inject: config.inject ?? [],
        } as FactoryProvider<QueueDashboardOptions, Deps>),
        dashboardProvider(),
      ],
    };
  }
}

const dashboardProvider = () =>
  provide(QUEUE_DASHBOARD, {
    useFactory: (options: QueueDashboardOptions) => new QueueDashboard(options),
    inject: [QueueDashboardOptions] as const,
  });
