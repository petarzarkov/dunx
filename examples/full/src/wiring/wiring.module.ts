import { Module, provide } from '@dunx/core';
import { AppConfigService } from '../config.js';
import { BuildInfo } from './build-info.service.js';
import { BUILD_STAMP, FEATURE_FLAGS, type BuildStamp } from './tokens.js';
import { WiringController } from './wiring.controller.js';
import { WiringDemo } from './wiring.demo.js';

/**
 * The three shapes of `provide()` side by side. Everywhere else a bare class in
 * `providers` is shorthand for `useClass` onto itself. There is no `useExisting`:
 * `provide(Alias, { useFactory: (real) => real, inject: [Real] })` is the same.
 */
@Module({
  controllers: [WiringController],
  providers: [
    provide(FEATURE_FLAGS, {
      useValue: new Set(['transactions', 'websockets', 'openapi']),
    }),

    // `useFactory` - computed once at boot. `inject` is a tuple and parameters
    // type from it positionally. A factory cannot call `inject()`: after its
    // first `await` the ambient injector is no longer its own.
    provide(BUILD_STAMP, {
      useFactory: (config: AppConfigService): BuildStamp => ({
        startedAt: new Date().toISOString(),
        revision: `${config.get('appName')}-dev`,
      }),
      inject: [AppConfigService] as const,
    }),

    // `useClass` - the long form, and what a test override swaps.
    provide(BuildInfo, { useClass: BuildInfo }),

    WiringDemo,
  ],
  exports: [WiringDemo],
})
export class WiringModule {}
