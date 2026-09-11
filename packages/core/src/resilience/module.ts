import type { DynamicModule, ModuleRef } from '../di/module.js';
import {
  provide,
  type AsyncModuleConfig,
  type Deps,
  type FactoryProvider,
} from '../di/provider.js';
import { token, type Ctor, type Token } from '../di/token.js';
import { ResilienceOptions, type ResilienceOptionsInit } from './options.js';
import { ResiliencePolicy } from './policy.js';

const tokens = new Map<string, Token<ResiliencePolicy>>();

/**
 * The token a named policy is bound to. Memoised, so the module and a consumer
 * hold the same token for `'payment'`: `token()` returns a fresh object per call.
 *
 * A `Token` is not a constructor type, so reach one with `inject()` in a field
 * initialiser, or pass `as` a subclass for an ordinary constructor parameter.
 * The same shape as `httpClient(name)`, which documents it at length.
 */
export const resiliencePolicy = (name: string): Token<ResiliencePolicy> => {
  const existing = tokens.get(name);
  if (existing) return existing;
  const created = token<ResiliencePolicy>(`ResiliencePolicy(${name})`);
  tokens.set(name, created);
  return created;
};

/**
 * How a policy is addressed: a name, which binds a `Token`, or a subclass of
 * `ResiliencePolicy`, which binds the class itself.
 */
export type PolicyTarget = string | Ctor<ResiliencePolicy>;

const policyFrom = (
  target: Token<ResiliencePolicy> | Ctor<ResiliencePolicy>,
  optionsToken: Token<ResilienceOptions> | typeof ResilienceOptions,
  // The concrete class to construct. A subclass binds itself, so the instance has
  // to be one.
  ctor: Ctor<ResiliencePolicy> = ResiliencePolicy,
) =>
  provide(target, {
    useFactory: (options: ResilienceOptions) =>
      new (ctor as new (options: ResilienceOptions) => ResiliencePolicy)(
        options,
      ),
    inject: [optionsToken] as const,
  });

/**
 * A named policy binds its own options token, so two of them do not collide on
 * `ResilienceOptions`, which a scope reports as a duplicate.
 */
const namedModule = (
  target: PolicyTarget,
  options: ResilienceOptions | FactoryProvider<ResilienceOptions, Deps>,
  imports: readonly ModuleRef[] = [],
): DynamicModule => {
  const label = typeof target === 'string' ? target : target.name;
  const policy = typeof target === 'string' ? resiliencePolicy(target) : target;
  const ctor = typeof target === 'string' ? ResiliencePolicy : target;
  const optionsToken = token<ResilienceOptions>(`ResilienceOptions(${label})`);
  const optionsProvider =
    options instanceof ResilienceOptions
      ? provide(optionsToken, { useValue: options })
      : provide(optionsToken, options);

  return {
    module: ResilienceModule,
    imports,
    exports: [optionsToken, policy],
    providers: [optionsProvider, policyFrom(policy, optionsToken, ctor)],
  };
};

/**
 * Timeout, retry, backoff, jitter and fallback, as an injectable policy.
 *
 * ```ts
 * ResilienceModule.forRoot({
 *   name: 'payment',
 *   timeoutMs: 3_000,
 *   retry: { maxRetries: 3, retryDelayMs: 200 },
 * });
 * ```
 */
export class ResilienceModule {
  /**
   * Binds `ResiliencePolicy` and `ResilienceOptions`.
   *
   * Pass `as` a subclass, or set `init.name`, to register an additional policy
   * instead. Either way it does not also claim `ResiliencePolicy`, so several
   * policies coexist alongside one default.
   *
   * ```ts
   * export class PaymentPolicy extends ResiliencePolicy {}
   * ResilienceModule.forRoot({ timeoutMs: 3_000 }, PaymentPolicy);
   *
   * class Checkout {
   *   constructor(private readonly policy: PaymentPolicy) {}
   * }
   * ```
   */
  static forRoot(
    init: ResilienceOptionsInit = {},
    as?: Ctor<ResiliencePolicy>,
  ): DynamicModule {
    const options = new ResilienceOptions(init);
    const target = as ?? options.name;
    if (target !== undefined) return namedModule(target, options);

    return {
      module: ResilienceModule,
      exports: [ResilienceOptions, ResiliencePolicy],
      providers: [
        provide(ResilienceOptions, { useValue: options }),
        policyFrom(ResiliencePolicy, ResilienceOptions),
      ],
    };
  }

  /**
   * `forRoot` with the options behind a factory, so the budget can come off
   * `ConfigService`.
   *
   * The second parameter is positional rather than a field of the awaited init,
   * because the token has to exist before the factory runs.
   */
  static forRootAsync(
    load: () => ResilienceOptionsInit | Promise<ResilienceOptionsInit>,
    as?: PolicyTarget,
  ): DynamicModule;
  static forRootAsync<const D extends Deps>(
    config: AsyncModuleConfig<ResilienceOptionsInit, D>,
    as?: PolicyTarget,
  ): DynamicModule;
  static forRootAsync(
    source:
      | (() => ResilienceOptionsInit | Promise<ResilienceOptionsInit>)
      | AsyncModuleConfig<ResilienceOptionsInit, Deps>,
    as?: PolicyTarget,
  ): DynamicModule {
    const load = typeof source === 'function' ? source : source.useFactory;
    const inject = typeof source === 'function' ? [] : (source.inject ?? []);
    // The container is scoped: this dynamic module is its own scope, so a factory
    // injecting a provider needs the module that exports it in *these* imports.
    const imports = typeof source === 'function' ? [] : (source.imports ?? []);
    const useFactory = async (
      ...deps: readonly unknown[]
    ): Promise<ResilienceOptions> => new ResilienceOptions(await load(...deps));

    if (as !== undefined) {
      return namedModule(
        as,
        { useFactory, inject } as FactoryProvider<ResilienceOptions, Deps>,
        imports,
      );
    }

    return {
      module: ResilienceModule,
      imports,
      exports: [ResilienceOptions, ResiliencePolicy],
      providers: [
        provide(ResilienceOptions, { useFactory, inject } as FactoryProvider<
          ResilienceOptions,
          Deps
        >),
        policyFrom(ResiliencePolicy, ResilienceOptions),
      ],
    };
  }
}
