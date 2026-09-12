import { Module } from '@dunx/core';
import { Audit } from './audit.service.js';
import { EventsController } from './events.controller.js';
import { EventsDemo } from './events.demo.js';
import { Notifications } from './notifications.service.js';
import { Orders } from './orders.service.js';
import { Startup } from './startup.service.js';

/** The subscribers. Neither class is injected by the publisher. */
@Module({ providers: [Audit, Notifications], exports: [Audit, Notifications] })
export class SubscribersModule {}

/**
 * `Orders` injects `EventBus` and nothing else, so publishing costs no import.
 * `SubscribersModule` is here for the other direction: the controller reads the
 * rows a handler wrote.
 *
 * `EventBusModule` is imported by the app root instead, after this module, and it
 * is `global: true`. `Startup` still reaches its subscriber from `onInit`.
 */
@Module({
  imports: [SubscribersModule],
  controllers: [EventsController],
  providers: [Orders, Startup, EventsDemo],
  exports: [EventsDemo, Startup],
})
export class EventsModule {}
