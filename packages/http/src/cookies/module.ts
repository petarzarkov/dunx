import {
  Module,
  provide,
  type AsyncModuleConfig,
  type Deps,
  type DynamicModule,
} from '@dunx/core';
import { SignedCookies, type SignedCookiesInit } from './signed.js';

const EXPORTS = [SignedCookies];

/**
 * Binds `SignedCookies` over the app's secrets. `global: true`, because the
 * secrets are the app's and a controller in any module signs with them.
 *
 * ```ts
 * SignedCookiesModule.forRootAsync({
 *   useFactory: (config: AppConfigService) => ({
 *     secrets: config.get('COOKIE_SECRETS').split(','),
 *   }),
 *   inject: [AppConfigService] as const,
 * });
 * ```
 */
@Module({})
export class SignedCookiesModule {
  static forRoot(init: SignedCookiesInit): DynamicModule {
    return {
      module: SignedCookiesModule,
      global: true,
      exports: EXPORTS,
      providers: [
        provide(SignedCookies, { useValue: new SignedCookies(init) }),
      ],
    };
  }

  static forRootAsync<const D extends Deps>(
    config: AsyncModuleConfig<SignedCookiesInit, D>,
  ): DynamicModule {
    return {
      module: SignedCookiesModule,
      global: true,
      ...(config.imports && { imports: config.imports }),
      exports: EXPORTS,
      providers: [
        provide(SignedCookies, {
          useFactory: async (...deps: readonly unknown[]) =>
            new SignedCookies(
              await (
                config.useFactory as (
                  ...args: readonly unknown[]
                ) => SignedCookiesInit | Promise<SignedCookiesInit>
              )(...deps),
            ),
          inject: config.inject ?? [],
        }),
      ],
    };
  }
}
