import {
  Module,
  provide,
  type Deps,
  type DynamicModule,
  type AsyncModuleConfig,
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
 * Serves a directory. Like the dashboard, it does not register itself:
 *
 * ```ts
 * const app = await HttpFactory.create(AppModule);
 * app.use(StaticFiles);
 * ```
 *
 * Position in the chain is left to the app - assets usually want to be outside an
 * auth guard and inside request logging. Anything outside the mount falls through
 * untouched.
 *
 * There is no `index.html` fallback and no SPA rewrite, which would mean this
 * middleware deciding what a 404 means for paths it does not own. An app that
 * wants one writes a middleware outside this one, reading `ctx.get(UNMATCHED)`
 * rather than a returned status, since a miss is thrown:
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
 * `notFound: 'guarded'`, the default, reports a miss with no route metadata, so a
 * session guard refuses it with a 401; a SPA wants `notFound: 'public'`.
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
    config: AsyncModuleConfig<StaticOptionsInit, D>,
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
