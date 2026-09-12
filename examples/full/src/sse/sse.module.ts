import { Module } from '@dunx/core';
import { UpstreamModule } from '../upstream/upstream.module.js';
import { EventsController } from './events.controller.js';
import { NotificationFeed } from './notification.feed.js';
import { SseDemo } from './sse.demo.js';

/**
 * `UpstreamModule` for `HttpService`, which is how the demo reads the stream this
 * module serves. A scope resolves what its own imports reach, so importing it
 * beside this one would not reach `SseDemo`.
 */
@Module({
  imports: [UpstreamModule],
  controllers: [EventsController],
  providers: [NotificationFeed, SseDemo],
  exports: [NotificationFeed, SseDemo],
})
export class SseModule {}
