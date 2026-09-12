import { Logger } from '@dunx/core';
import { HttpService } from '@dunx/http/client';
import { NotificationFeed } from './notification.feed.js';

/** The `tick` number out of one `data:` payload. */
const tickOf = (data: string): number =>
  (JSON.parse(data) as { tick: number }).tick;

export class SseDemo {
  constructor(
    private readonly logger: Logger,
    private readonly http: HttpService,
    private readonly feed: NotificationFeed,
  ) {}

  async demonstrate(url: string): Promise<void> {
    const first = await this.read(url, 3);
    this.logger.info(
      `@Sse -> streamSse read ${first.length} events: ` +
        `ticks ${first.map(tickOf).join(', ')}`,
    );

    // The id of the last event seen, sent back the way an EventSource does.
    const resumed = await this.read(url, 2, String(tickOf(first.at(-1) ?? '')));
    this.logger.info(
      `Last-Event-ID: 3 -> resumed at tick ${tickOf(resumed[0] ?? '')}`,
    );

    await this.framing(url);
    await this.pushed(url);
  }

  /** Every `data:` payload of `/api/events/ticks`, to the end of the stream. */
  private async read(
    url: string,
    count: number,
    lastEventId?: string,
  ): Promise<readonly string[]> {
    const seen: string[] = [];
    for await (const data of this.http.streamSse({
      method: 'GET',
      url: new URL(`api/events/ticks?count=${count}`, url),
      ...(lastEventId === undefined
        ? {}
        : { headers: { 'last-event-id': lastEventId } }),
    })) {
      seen.push(data);
    }
    return seen;
  }

  /**
   * The wire, unparsed. `app.use(Compression)` is registered ahead of these
   * routes, and an encoded event stream would arrive whole or not at all.
   */
  private async framing(url: string): Promise<void> {
    const response = await fetch(new URL('api/events/ticks?count=1', url), {
      headers: { 'accept-encoding': 'gzip, zstd' },
    });
    const body = await response.text();
    this.logger.info(
      `content-type: ${response.headers.get('content-type')}, ` +
        `content-encoding: ${response.headers.get('content-encoding') ?? 'identity'}`,
    );

    const [opening = '', first = ''] = body.split('\n\n');
    this.logger.info(
      `opens with ${JSON.stringify(opening)}, a comment line, so the headers ` +
        `flush before the first event: ${first.split('\n').join(' / ')}`,
    );
  }

  /** The pushed half: a stream the app writes into, and what a disconnect does. */
  private async pushed(url: string): Promise<void> {
    const client = new AbortController();
    const response = await fetch(new URL('api/events/notifications', url), {
      signal: client.signal,
    });
    const reader = response.body?.getReader();
    if (reader === undefined)
      throw new Error('no body on the notifications stream');

    this.feed.publish('deploy finished');
    const decoder = new TextDecoder();
    let read = '';
    while (!read.includes('event: notice')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      read += decoder.decode(chunk.value, { stream: true });
    }
    const frame = read.split('\n\n').find((f) => f.startsWith('event:')) ?? '';
    this.logger.info(
      `SseStream, ${this.feed.subscribers} subscriber, pushed: ` +
        `${frame.split('\n').join(' / ')}`,
    );

    client.abort();
    await Bun.sleep(20);
    this.logger.info(
      `the client left -> ${this.feed.subscribers} subscribers, and its ` +
        'heartbeat timer went with it',
    );
  }
}
