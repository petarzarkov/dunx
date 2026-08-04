import type {
  AppControllerRoute,
  AppViewRoute,
  BullBoardQueues,
  ControllerHandlerReturnType,
  IServerAdapter,
  UIConfig,
} from '@bull-board/api/typings/app';

/**
 * bull-board's `IServerAdapter`, implemented over `Bun.serve`.
 *
 * bull-board ships adapters for express, fastify, koa, hapi, hono and elysia, and
 * dunx can use none of them: express is banned repo-wide, and hono or elysia would
 * mean running a second HTTP framework inside a dunx app to serve one page. So dunx
 * writes the adapter, which is the same division bullmq's own
 * `createBunRedisClient` follows - the library owns the abstraction, Bun owns the
 * I/O.
 *
 * The interface makes that cheap: it is a **sink**. bull-board pushes its routes,
 * its view path, its static path, an error handler and the UI config in, and the
 * adapter answers requests from them. Nothing is pulled.
 */
export type Renderer = (
  viewPath: string,
  params: Record<string, unknown>,
) => Promise<string>;

interface Handled {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array | null;
}

const json = (body: unknown, status: number): Handled => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? null : JSON.stringify(body),
});

/**
 * bull-board states routes as express paths - `/api/queues/:queueName/:id`. Matched
 * here rather than handed to `Bun.serve({ routes })`, because these routes are
 * mounted **under** an app's own route table at a base path chosen at runtime, and
 * because bull-board hands them over as data after the server is already built.
 */
const compile = (
  route: string,
): { readonly pattern: RegExp; readonly params: readonly string[] } => {
  const params: string[] = [];
  const pattern = route
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return escapeRegex(segment);
      params.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { pattern: new RegExp(`^${pattern}$`), params };
};

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Registered {
  readonly methods: readonly string[];
  readonly pattern: RegExp;
  readonly params: readonly string[];
  readonly handler: AppControllerRoute['handler'];
}

export class BunServeAdapter implements IServerAdapter {
  #queues: BullBoardQueues | undefined;
  #viewPath: string | undefined;
  #staticRoute: string | undefined;
  #staticPath: string | undefined;
  #entry: AppViewRoute | undefined;
  #errorHandler: ((error: Error) => ControllerHandlerReturnType) | undefined;
  #uiConfig: UIConfig = {};
  readonly #routes: Registered[] = [];

  /**
   * `basePath` is where the board is mounted, and `render` turns bull-board's entry
   * template into HTML. The renderer is injected rather than imported so this class
   * needs no template engine of its own - see `render.ts`.
   */
  constructor(
    private readonly basePath: string,
    private readonly render: Renderer,
  ) {}

  setQueues(queues: BullBoardQueues): IServerAdapter {
    this.#queues = queues;
    return this;
  }

  setViewsPath(viewPath: string): IServerAdapter {
    this.#viewPath = viewPath;
    return this;
  }

  setStaticPath(staticsRoute: string, staticsPath: string): IServerAdapter {
    this.#staticRoute = staticsRoute;
    this.#staticPath = staticsPath;
    return this;
  }

  setEntryRoute(route: AppViewRoute): IServerAdapter {
    this.#entry = route;
    return this;
  }

  setErrorHandler(
    handler: (error: Error) => ControllerHandlerReturnType,
  ): IServerAdapter {
    this.#errorHandler = handler;
    return this;
  }

  setApiRoutes(routes: AppControllerRoute[]): IServerAdapter {
    for (const { method, route, handler } of routes) {
      const methods = (Array.isArray(method) ? method : [method]).map((verb) =>
        verb.toUpperCase(),
      );
      for (const path of Array.isArray(route) ? route : [route]) {
        this.#routes.push({ methods, handler, ...compile(path) });
      }
    }
    return this;
  }

  setUIConfig(config: UIConfig): IServerAdapter {
    this.#uiConfig = config;
    return this;
  }

  /**
   * Answers a request, or `undefined` when the path is not the board's - which is
   * what lets the caller fall through to the app's own 404 rather than the board
   * claiming everything under its prefix.
   */
  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const path = this.#relative(url.pathname);
    if (path === undefined) return undefined;

    const asset = await this.#asset(path);
    if (asset !== undefined) return asset;

    const api = await this.#api(request, url, path);
    if (api !== undefined) return api;

    return this.#entryPage(path);
  }

  /** The path with the mount prefix removed, or undefined if it is not under it. */
  #relative(pathname: string): string | undefined {
    const base = this.basePath === '/' ? '' : this.basePath;
    if (base === '') return pathname;
    if (!pathname.startsWith(base)) return undefined;
    const rest = pathname.slice(base.length);
    return rest === '' ? '/' : rest.startsWith('/') ? rest : undefined;
  }

  /**
   * `Bun.file` serves the UI bundle, which is 2.7 MB of hashed assets - so they are
   * streamed from disk with the runtime's own sendfile path rather than read into
   * memory, and given a long cache since the filenames carry a content hash.
   *
   * The path is resolved and then checked to still sit under the static root, so a
   * `..` in the request cannot walk out of it.
   */
  async #asset(path: string): Promise<Response | undefined> {
    const route = this.#staticRoute;
    const root = this.#staticPath;
    if (route === undefined || root === undefined) return undefined;
    if (!path.startsWith(`${route}/`)) return undefined;

    const relative = decodeURIComponent(path.slice(route.length + 1));
    const resolved = `${root}/${relative}`.replace(/\/{2,}/g, '/');
    if (!resolved.startsWith(root) || relative.includes('..')) {
      return new Response('Forbidden', { status: 403 });
    }

    const file = Bun.file(resolved);
    if (!(await file.exists())) return undefined;
    return new Response(file, {
      headers: { 'cache-control': 'public, max-age=31536000, immutable' },
    });
  }

  async #api(
    request: Request,
    url: URL,
    path: string,
  ): Promise<Response | undefined> {
    const queues = this.#queues;
    if (queues === undefined) return undefined;

    for (const route of this.#routes) {
      const match = route.pattern.exec(path);
      if (match === null) continue;
      if (!route.methods.includes(request.method)) continue;

      const params: Record<string, string> = {};
      route.params.forEach((name, at) => {
        params[name] = decodeURIComponent(match[at + 1] ?? '');
      });

      // The UI omits a body on most requests, so a parse failure is expected
      // rather than exceptional.
      let body: unknown = {};
      if (request.method !== 'GET') {
        body = await request.json().catch(() => ({}));
      }

      const result = await this.#run(() =>
        route.handler({
          queues,
          uiConfig: this.#uiConfig,
          params,
          query: Object.fromEntries(url.searchParams),
          body,
          headers: Object.fromEntries(request.headers),
        } as Parameters<AppControllerRoute['handler']>[0]),
      );

      return result.status === 204
        ? new Response(null, { status: 204 })
        : new Response(result.body, {
            status: result.status,
            headers: result.headers,
          });
    }

    return undefined;
  }

  /**
   * bull-board types a handler's return as `Promisify<T>` - it may be sync or
   * async - so the callback is typed the same way and awaited either way.
   */
  async #run(
    call: () =>
      | ControllerHandlerReturnType
      | Promise<ControllerHandlerReturnType>,
  ): Promise<Handled> {
    try {
      const response = await call();
      return json(response.body, response.status ?? 200);
    } catch (error) {
      if (this.#errorHandler === undefined || !(error instanceof Error))
        throw error;
      const response = this.#errorHandler(error);
      const status = response.status === 204 ? 500 : (response.status ?? 500);
      return typeof response.body === 'string'
        ? {
            status,
            headers: { 'content-type': 'text/plain' },
            body: response.body,
          }
        : json(response.body, status);
    }
  }

  async #entryPage(path: string): Promise<Response | undefined> {
    const entry = this.#entry;
    const viewPath = this.#viewPath;
    if (entry === undefined || viewPath === undefined) return undefined;

    const routes = Array.isArray(entry.route) ? entry.route : [entry.route];
    if (!routes.includes(path)) return undefined;

    const { name, params } = entry.handler({
      basePath: this.basePath,
      uiConfig: this.#uiConfig,
    });
    const html = await this.render(
      `${viewPath}/${name}`,
      params as Record<string, unknown>,
    );
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
}
