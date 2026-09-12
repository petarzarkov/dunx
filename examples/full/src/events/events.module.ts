import { EventBusModule, Module } from '@dunx/core';
import { Audit } from './audit.service.js';
import { EventsController } from './events.controller.js';
import { EventsDemo } from './events.demo.js';
import { Notifications } from './notifications.service.js';
import { Orders } from './orders.service.js';

/**
 * The subscribers. Neither class is injected by the publisher, and this module
 * imports nothing: `EventRegistry` finds `@OnEvent` by walking the classes the
 * modules already declare.
 */
@Module({ providers: [Audit, Notifications], exports: [Audit, Notifications] })
export class SubscribersModule {}

/**
 * `Orders` injects `EventBus` and nothing else, so publishing costs no import.
 * `SubscribersModule` is here for the opposite direction: the controller reads
 * the rows a handler wrote, to show the work finished before `emit` resolved.
 *
 * `EventBusModule` is a decorated class rather than a `forRoot()` and is
 * `global: true` - a scope is keyed on the module reference, so a zero-argument
 * `forRoot()` would build a second bus per importer and split the subscribers
 * between them.
 */
@Module({
  imports: [EventBusModule, SubscribersModule],
  controllers: [EventsController],
  providers: [Orders, EventsDemo],
  exports: [EventsDemo],
})
export class EventsModule {}
