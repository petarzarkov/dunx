import {
  Controller,
  Sse,
  SseStream,
  type SseEvent,
  type SseInput,
  type SseSchemas,
} from '@dunx/http';
import { ApiDoc } from '@dunx/openapi';
import { z } from 'zod';
import { NotificationFeed } from './notification.feed.js';

const ticks = {
  query: z.object({ count: z.coerce.number().int().min(1).max(20).default(3) }),
} as const satisfies SseSchemas;

@ApiDoc({
  tags: ['Events'],
  description:
    'Server-sent events: a generator, and a stream the app pushes into.',
})
@Controller('events')
export class EventsController {
  constructor(private readonly feed: NotificationFeed) {}

  /**
   * A generator per connection. `Last-Event-ID` carries the last tick the client
   * saw, so a reconnect continues rather than starting over.
   */
  @Sse('/ticks', ticks)
  async *ticks(input: SseInput<typeof ticks>): AsyncGenerator<SseEvent> {
    // Nothing guarantees the id a client sends back is one of ours, and
    // `Number('abc')` is NaN, which answers a reconnect with no events.
    const seen = Number(input.lastEventId ?? '0');
    const from = Number.isFinite(seen) && seen >= 0 ? seen : 0;
    for (let tick = from + 1; tick <= from + input.query.count; tick += 1) {
      yield { data: { tick }, event: 'tick', id: String(tick) };
      await Bun.sleep(5);
    }
  }

  /** A stream the handler hands over, held open until the client goes away. */
  @Sse('/notifications')
  notifications(_input: SseInput<SseSchemas>): SseStream {
    return this.feed.subscribe();
  }
}
