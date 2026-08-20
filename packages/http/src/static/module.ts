import {
  Module,
  provide,
  type Deps,
  type DynamicModule,
  type FactoryProvider,
  type Registration,
} from '@dunx/core';
import { StaticFiles } from './files.js';
import { StaticOptions, type StaticOptionsInit } from './options.js';

const files = (): Registration =>
  provide(StaticFiles, {
    useFactory: (options: StaticOptions) => new StaticFiles(options),
    inject: [StaticOptions] as const,
  });

/**
 * Serves a directory, the way Nest's `ServeStaticModule` does - and like the
 * dashboard, **it does not register itself**. The app does:
 *
 * ```ts
 * const app = await HttpFactory.create(AppModule);
 * app.use(StaticFiles);
 * ```
 *
 * Position in the chain is the decision being left to the app. Static assets
 * usually want to be *outside* an auth guard and *inside* request logging, and no
 * default can know which. Anything outside the mount falls through untouched, so
 * the app's own routes and its 404 behave exactly as before.
 *
 * There is no `index.html` fallback and no SPA rewrite: building them in would mean
 * this middleware deciding what a 404 means for paths it does not own.
 *
 * An app that wants one writes a middleware **outside** this one, and the shape
 * matters. An unmatched path is a **thrown** `HttpError(404)`, not a returned
 * `Response` - see `buildFallback` - so reading `(await next()).status` never sees a
 * miss, and `ctx.get(UNMATCHED)` is what does:
 *
 * ```ts
 * export class SpaFallback implements Middleware {
 *   async handle(req: BunRequest, ctx: RouteContext, next: Next) {
 *     const missed = ctx.get(UNMATCHED) === true;
 *     if (
 *       !missed ||
 *       req.method !== 'GET' ||
 *       new URL(req.url).pathname.startsWith('/api') ||
 *       !(req.headers.get('accept') ?? '').includes('text/html')
 *     ) {
 *       return next();
 *     }
 *     const index = Bun.file(`${root}/index.html`);
 *     if (!(await index.exists())) return next();
 *     // The document carries the hashed asset names, so a stale one points at
 *     // bundles that no longer exist.
 *     return new Response(index, {
 *       headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
 *     });
 *   }
 * }
 * ```
 *
 * Two more things that shape where it goes in the chain. `notFound: 'guarded'` -
 * the default - reports a miss with no route metadata, so a global session guard
 * refuses it and the status is a 401 rather than a 404; an app serving a SPA wants
 * `notFound: 'public'`. And the fallback answers **before** any middleware listed
 * after the guard, so the rewrite has to sit ahead of the guard to see the miss at
 * all.
 */
@Module({})
export class StaticModule {
  static forRoot(init: StaticOptionsInit): DynamicModule {
    return {
      module: StaticModule,
      exports: [StaticOptions, StaticFiles],
      providers: [
        provide(StaticOptions, { useValue: new StaticOptions(init) }),
        files(),
      ],
    };
  }

  /** `forRoot` with the root read off the container - a config value, usually. */
  static forRootAsync<const D extends Deps>(
    config: FactoryProvider<StaticOptionsInit, D> & {
      readonly imports?: DynamicModule['imports'];
    },
  ): DynamicModule {
    return {
      module: StaticModule,
      ...(config.imports && { imports: config.imports }),
      exports: [StaticOptions, StaticFiles],
      providers: [
        provide(StaticOptions, {
          useFactory: async (...deps: readonly unknown[]) =>
            new StaticOptions(
              await (
                config.useFactory as (
                  ...args: readonly unknown[]
                ) => StaticOptionsInit | Promise<StaticOptionsInit>
              )(...deps),
            ),
          inject: config.inject ?? [],
        }),
        files(),
      ],
    };
  }
}
