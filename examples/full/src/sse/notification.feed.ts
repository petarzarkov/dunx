import { SseStream } from '@dunx/http';

/**
 * The subscribers of `/api/events/notifications`, as streams the app pushes into
 * rather than generators it pulls from.
 */
export class NotificationFeed {
  readonly #streams = new Set<SseStream>();

  /** A stream for one client, with a comment line every 15 s to hold it open. */
  subscribe(): SseStream {
    const stream = new SseStream({ heartbeatMs: 15_000 });
    this.#streams.add(stream);
    return stream;
  }

  publish(message: string): void {
    for (const stream of this.#streams) {
      if (stream.closed) this.#streams.delete(stream);
      else stream.send({ data: { message }, event: 'notice' });
    }
  }

  /** Live subscribers. A client that disconnected closed its own stream. */
  get subscribers(): number {
    for (const stream of this.#streams) {
      if (stream.closed) this.#streams.delete(stream);
    }
    return this.#streams.size;
  }
}
