import {
  Logger,
  provide,
  RequestContext,
  token,
  type Deps,
  type DynamicModule,
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
 * A `Token` is not a constructor type, so a named client cannot be a constructor
 * parameter. Reach it with `inject()` in a field initialiser:
 *
 * ```ts
 * class Payments {
 *   readonly stripe = inject(httpClient('stripe'));
 * }
 * ```
 */
export const httpClient = (name: string): Token<HttpService> => {
  const existing = tokens.get(name);
  if (existing) return existing;
  const created = token<HttpService>(`HttpService(${name})`);
  tokens.set(name, created);
  return created;
};

const serviceFrom = (
  target: Token<HttpService> | typeof HttpService,
  optionsToken: Token<HttpClientOptions> | typeof HttpClientOptions,
) =>
  provide(target, {
    useFactory: (
      options: HttpClientOptions,
      logger: Logger,
      context: RequestContext,
    ) => new HttpService(options, logger, context),
    inject: [optionsToken, Logger, RequestContext] as const,
  });

/**
 * A named client binds its own options token, so two of them do not collide on
 * `HttpClientOptions` - the flat container reports that as a duplicate binding.
 */
const namedModule = (
  name: string,
  options: HttpClientOptions | FactoryProvider<HttpClientOptions, Deps>,
): DynamicModule => {
  const optionsToken = token<HttpClientOptions>(`HttpClientOptions(${name})`);
  const optionsProvider =
    options instanceof HttpClientOptions
      ? provide(optionsToken, { useValue: options })
      : provide(optionsToken, options);

  return {
    module: HttpModule,
    exports: [optionsToken, httpClient(name)],
    providers: [optionsProvider, serviceFrom(httpClient(name), optionsToken)],
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
   * Binds `HttpService` and `HttpClientOptions`, or `httpClient(init.name)` alone
   * when `name` is set - a named registration deliberately does not also claim
   * `HttpService`, so several upstreams can coexist alongside one default.
   */
  static forRoot(init: HttpClientOptionsInit = {}): DynamicModule {
    const options = new HttpClientOptions(init);
    if (options.name !== undefined) return namedModule(options.name, options);

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
   * `forRoot` with the options behind a factory, which is the one thing a
   * zero-argument `forRoot` cannot do: read the base url or the timeout off
   * `ConfigService`.
   *
   * There is no separate async machinery - the container resolves eagerly and
   * awaits factories before any constructor runs, so awaited config is settled by
   * the time anything is built.
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
   * `name` is a parameter rather than a field of the awaited init, because the
   * token has to exist before the factory runs.
   */
  static forRootAsync(
    load: () => HttpClientOptionsInit | Promise<HttpClientOptionsInit>,
    name?: string,
  ): DynamicModule;
  static forRootAsync<const D extends Deps>(
    config: FactoryProvider<HttpClientOptionsInit, D>,
    name?: string,
  ): DynamicModule;
  static forRootAsync(
    source:
      | (() => HttpClientOptionsInit | Promise<HttpClientOptionsInit>)
      | FactoryProvider<HttpClientOptionsInit, Deps>,
    name?: string,
  ): DynamicModule {
    const load = typeof source === 'function' ? source : source.useFactory;
    const inject = typeof source === 'function' ? [] : (source.inject ?? []);
    const useFactory = async (
      ...deps: readonly unknown[]
    ): Promise<HttpClientOptions> => new HttpClientOptions(await load(...deps));

    if (name !== undefined) {
      return namedModule(name, { useFactory, inject } as FactoryProvider<
        HttpClientOptions,
        Deps
      >);
    }

    return {
      module: HttpModule,
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
