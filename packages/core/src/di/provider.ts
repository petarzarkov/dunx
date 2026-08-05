import type { ModuleRef } from './module.js';
import type { Ctor, InjectionToken } from './token.js';

export type Deps = readonly InjectionToken<unknown>[];

export type Resolved<D extends Deps> = {
  [K in keyof D]: D[K] extends InjectionToken<infer U> ? U : never;
};

export interface ValueProvider<T> {
  readonly useValue: T;
}

export interface ClassProvider<T> {
  readonly useClass: Ctor<T>;
}

export interface FactoryProvider<T, D extends Deps> {
  readonly useFactory: (...deps: Resolved<D>) => T | Promise<T>;
  // Factories cannot use inject() - after the first await the module-level
  // current injector is no longer theirs - so their dependencies are declared.
  readonly inject?: D;
}

/**
 * What a `forRootAsync` takes: a factory, its dependencies, and **the modules those
 * dependencies come from**.
 *
 * `imports` exists because of where the factory runs. It is written at the call site,
 * inside the importing module, but the provider it produces is registered in the
 * *configured* module's scope - so a factory injecting `DbConnection` is asking a
 * library module to resolve a token only the app's module can see. Naming the module
 * it comes from is what closes that, and it is the same field Nest's
 * `forRootAsync({ imports })` fills.
 *
 * Not needed for a token from a `global: true` module. `ConfigService` is the common
 * case and `ConfigModule` is global, which is why most factories need nothing here.
 */
export interface AsyncModuleConfig<T, D extends Deps> extends FactoryProvider<
  T,
  D
> {
  readonly imports?: readonly ModuleRef[];
}

export type ErasedProvider =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'class'; readonly ctor: Ctor<unknown> }
  | {
      readonly kind: 'factory';
      readonly deps: Deps;
      readonly factory: (...deps: readonly unknown[]) => unknown;
    };

export interface Registration {
  readonly token: InjectionToken<unknown>;
  readonly provider: ErasedProvider;
}

export function provide<T>(
  token: InjectionToken<T>,
  provider: ValueProvider<T> | ClassProvider<T>,
): Registration;
export function provide<T, const D extends Deps>(
  token: InjectionToken<T>,
  provider: FactoryProvider<T, D>,
): Registration;
export function provide<T>(
  token: InjectionToken<T>,
  provider: ValueProvider<T> | ClassProvider<T> | FactoryProvider<T, Deps>,
): Registration {
  const erased: ErasedProvider =
    'useValue' in provider
      ? { kind: 'value', value: provider.useValue }
      : 'useClass' in provider
        ? { kind: 'class', ctor: provider.useClass }
        : {
            kind: 'factory',
            deps: provider.inject ?? [],
            factory: provider.useFactory as (
              ...deps: readonly unknown[]
            ) => unknown,
          };

  return { token: token as InjectionToken<unknown>, provider: erased };
}
