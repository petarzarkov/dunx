import {
  Logger,
  provide,
  RequestContext,
  token,
  type Deps,
  type ModuleRef,
  type DynamicModule,
  type AsyncModuleConfig,
  type Ctor,
  type FactoryProvider,
  type Token,
} from '@dunx/core';
import { HttpClientOptions, type HttpClientOptionsInit } from './options.js';
import { HttpService } from './service.js';

const tokens = new Map<string, Token<HttpService>>();

/**
 * The token a named client is bound to.
 *
 * Memoised, because `token()` returns a fresh object every call - without this the
 * module and the consumer would hold different tokens for `'stripe'` and the lookup
 * would miss. Same name in, same token out.
 *
 * A `Token` is not a constructor type, so a client registered under one cannot be a
 * constructor parameter. Reach it with `inject()` in a field initialiser:
 *
 * ```ts
 * class Payments {
 *   readonly stripe = inject(httpClient('stripe'));
 * }
 * ```
 *
 * Passing `as` a subclass instead gives an ordinary constructor parameter, and is
 * the shape to prefer for new code.
 */
export const httpClient = (name: string): Token<HttpService> => {
  const existing = tokens.get(name);
  if (existing) return existing;
  const created = token<HttpService>(`HttpService(${name})`);
  tokens.set(name, created);
  return created;
};

/**
 * How a client is addressed: a name, which binds a `Token`, or a subclass of
 * `HttpService`, which binds the class itself.
 *
 * A subclass is both a token and a parameter type, so `constructor(private readonly
 * email: EmailClient)` resolves - which a `Token` can never do. `as` is the spelling
 * `ConfigModule.forRoot({ validate, as })` already established.
 */
export type ClientTarget = string | Ctor<HttpService>;

const serviceFrom = (
  target: Token<HttpService> | Ctor<HttpService>,
  optionsToken: Token<HttpClientOptions> | typeof HttpClientOptions,
  // The concrete class to construct. A subclass binds itself, so the instance has
  // to be one - `new HttpService()` under an `EmailClient` token would fail every
  // `instanceof` and defeat the point of the subclass.
  ctor: Ctor<HttpService> = HttpService,
) =>
  provide(target, {
    useFactory: (
      options: HttpClientOptions,
      logger: Logger,
      context: RequestContext,
    ) =>
      new (ctor as new (
        options: HttpClientOptions,
        logger: Logger,
        context: RequestContext,
      ) => HttpService)(options, logger, context),
    inject: [optionsToken, Logger, RequestContext] as const,
  });

/**
 * A named client binds its own options token, so two of them do not collide on
 * `HttpClientOptions` - a scope binding that class twice reports a duplicate.
 */
const namedModule = (
  target: ClientTarget,
  options: HttpClientOptions | FactoryProvider<HttpClientOptions, Deps>,
  imports: readonly ModuleRef[] = [],
): DynamicModule => {
  const label = typeof target === 'string' ? target : target.name;
  const service = typeof target === 'string' ? httpClient(target) : target;
  const ctor = typeof target === 'string' ? HttpService : target;
  const optionsToken = token<HttpClientOptions>(`HttpClientOptions(${label})`);
  const optionsProvider =
    options instanceof HttpClientOptions
      ? provide(optionsToken, { useValue: options })
      : provide(optionsToken, options);

  return {
    module: HttpModule,
    imports,
    exports: [optionsToken, service],
    providers: [optionsProvider, serviceFrom(service, optionsToken, ctor)],
  };
};

/**
 * The outbound half of `@dunx/http`.
 *
 * Named `HttpModule` and `HttpService` under the `./client` subpath rather than in
 * the root barrel, where `HttpFactory` already means the inbound direction. The
 * subpath is what keeps the name unambiguous at the import site:
 *
 * ```ts
 * import { HttpFactory } from '@dunx/http';         // serving
 * import { HttpModule } from '@dunx/http/client';   // calling out
 * ```
 *
 * It depends on `Logger` and `RequestContext`, both of which core always binds, so
 * it works in an app that imported no logging module at all.
 */
export class HttpModule {
  /**
   * Binds `HttpService` and `HttpClientOptions`.
   *
   * Pass `as` a subclass, or set `init.name`, to register an additional client
   * instead. Either way it does not also claim `HttpService`, so several upstreams
   * coexist alongside one default.
   *
   * ```ts
   * export class EmailClient extends HttpService {}
   * HttpModule.forRoot({ baseUrl: 'https://email.internal' }, EmailClient);
   *
   * class Notifier {
   *   constructor(private readonly email: EmailClient) {}
   * }
   * ```
   */
  static forRoot(
    init: HttpClientOptionsInit = {},
    as?: Ctor<HttpService>,
  ): DynamicModule {
    const options = new HttpClientOptions(init);
    const target = as ?? options.name;
    if (target !== undefined) return namedModule(target, options);

    return {
      module: HttpModule,
      exports: [HttpClientOptions, HttpService],
      providers: [
        provide(HttpClientOptions, { useValue: options }),
        serviceFrom(HttpService, HttpClientOptions),
      ],
    };
  }

  /**
   * `forRoot` with the options behind a factory, so the base url or the timeout
   * can come off `ConfigService`.
   *
   * ```ts
   * HttpModule.forRootAsync({
   *   useFactory: (config: AppConfigService) => ({
   *     baseUrl: config.get('upstream').url,
   *   }),
   *   inject: [AppConfigService],
   * });
   * ```
   *
   * The second parameter is positional rather than a field of the awaited init,
   * because the token has to exist before the factory runs. A subclass there gives
   * a constructor parameter; a string gives an `httpClient(name)` token.
   */
  static forRootAsync(
    load: () => HttpClientOptionsInit | Promise<HttpClientOptionsInit>,
    as?: ClientTarget,
  ): DynamicModule;
  static forRootAsync<const D extends Deps>(
    config: AsyncModuleConfig<HttpClientOptionsInit, D>,
    as?: ClientTarget,
  ): DynamicModule;
  static forRootAsync(
    source:
      | (() => HttpClientOptionsInit | Promise<HttpClientOptionsInit>)
      | AsyncModuleConfig<HttpClientOptionsInit, Deps>,
    as?: ClientTarget,
  ): DynamicModule {
    const load = typeof source === 'function' ? source : source.useFactory;
    const inject = typeof source === 'function' ? [] : (source.inject ?? []);
    // The container is scoped: this dynamic module is its own scope, so a factory
    // injecting a provider needs the module that exports it in *these* imports.
    // Importing it into whatever module calls forRootAsync does not reach here.
    const imports = typeof source === 'function' ? [] : (source.imports ?? []);
    const useFactory = async (
      ...deps: readonly unknown[]
    ): Promise<HttpClientOptions> => new HttpClientOptions(await load(...deps));

    if (as !== undefined) {
      return namedModule(
        as,
        { useFactory, inject } as FactoryProvider<HttpClientOptions, Deps>,
        imports,
      );
    }

    return {
      module: HttpModule,
      imports,
      exports: [HttpClientOptions, HttpService],
      providers: [
        provide(HttpClientOptions, { useFactory, inject } as FactoryProvider<
          HttpClientOptions,
          Deps
        >),
        serviceFrom(HttpService, HttpClientOptions),
      ],
    };
  }
}
