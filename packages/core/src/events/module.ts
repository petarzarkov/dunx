import { AppRef } from '../di/app.js';
import type { ModuleRef } from '../di/module.js';
import { Module } from '../di/module.js';
import { provide } from '../di/provider.js';
import { Logger } from '../logger/logger.js';
import { EventBus } from './bus.js';
import { EventRegistry, EVENT_REGISTRY_DEPS } from './registry.js';

/**
 * Binds `EventBus` and `EventRegistry`, and subscribes every `@OnEvent` in the
 * graph at boot.
 *
 * `global: true`, so a subscriber's module does not import the publisher's - which
 * is the decoupling the bus exists for. Import it once, from the app root.
 *
 * ```ts
 * @Module({ imports: [EventBusModule, OrdersModule, AuditModule] })
 * export class AppModule {}
 * ```
 *
 * A decorated class rather than a `forRoot()`: a scope is keyed on the module
 * reference, so two importers calling a zero-argument one would build two buses
 * and a publisher would reach half its subscribers.
 */
@Module({
  global: true,
  providers: [
    provide(EventBus, {
      useFactory: (logger: Logger) => new EventBus(logger),
      inject: [Logger] as const,
    }),
    // Bound so the container constructs it, which is what gets `onInit` called.
    provide(EventRegistry, {
      // Typed rather than cast, so a constructor change is a compile error.
      useFactory: (
        ref: AppRef,
        root: ModuleRef,
        bus: EventBus,
        logger: Logger,
      ) => new EventRegistry(ref, root, bus, logger),
      inject: EVENT_REGISTRY_DEPS,
    }),
  ],
  exports: [EventBus, EventRegistry],
})
export class EventBusModule {}
