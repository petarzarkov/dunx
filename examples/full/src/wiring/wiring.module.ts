import { Module, provide } from '@dunx/core';
import { AppConfigService } from '../config.js';
import { BuildInfo } from './build-info.service.js';
import { BUILD_STAMP, FEATURE_FLAGS, type BuildStamp } from './tokens.js';
import { WiringController } from './wiring.controller.js';
import { WiringDemo } from './wiring.demo.js';

/**
 * The three shapes of `provide()`, side by side. Everything else in this app is a
 * bare class in `providers`, which is shorthand for `useClass` onto itself - that
 * is what a feature module should look like, and this one exists to show what the
 * shorthand is short for.
 *
 * There is no `useExisting`. Aliasing one token to another is
 * `provide(Alias, { useFactory: (real) => real, inject: [Real] })`, which is the
 * same thing without a fourth provider kind to document.
 */
@Module({
  controllers: [WiringController],
  providers: [
    // `useValue` - a constant, resolved before anything asks for it.
    provide(FEATURE_FLAGS, {
      useValue: new Set(['transactions', 'websockets', 'openapi']),
    }),

    // `useFactory` - computed once, at boot, from other bindings. `inject` is a
    // tuple of tokens and the parameters are typed from it positionally, with no
    // generics written by hand. Factories cannot use `inject()`: after their first
    // `await` the ambient injector is no longer theirs, so their dependencies are
    // declared instead of discovered.
    provide(BUILD_STAMP, {
      useFactory: (config: AppConfigService): BuildStamp => ({
        startedAt: new Date().toISOString(),
        revision: `${config.get('appName')}-dev`,
      }),
      inject: [AppConfigService] as const,
    }),

    // `useClass` - the long form of listing the bare class, and the form a test
    // override uses to swap the implementation without touching this file.
    provide(BuildInfo, { useClass: BuildInfo }),

    WiringDemo,
  ],
  exports: [WiringDemo],
})
export class WiringModule {}
