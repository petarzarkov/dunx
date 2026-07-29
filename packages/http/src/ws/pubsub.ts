import { AppError } from '@dunx/core';
import type { Server } from 'bun';
import { encode } from './envelope.js';
import type { SocketData } from './socket.js';

/**
 * Server-wide publish, delegating to Bun's own pub/sub. Topics live in the
 * runtime, not in a JavaScript registry: `socket.subscribe(topic)` is what joins
 * one, and Bun does the fan-out.
 *
 * Injectable — `HttpFactory` binds it, so a service can publish without holding a
 * socket and without registering anything.
 */
export class PubSub {
  #server: Server<SocketData> | undefined;

  /** Called with the live server by `listen()`; also usable directly. */
  attach(server: Server<SocketData>): void {
    this.#server = server;
  }

  get attached(): boolean {
    return this.#server !== undefined;
  }

  /** Bytes sent, `0` if the message was dropped, `-1` under backpressure. */
  publish(
    topic: string,
    data: string | Bun.BufferSource,
    compress?: boolean,
  ): number {
    return this.#live().publish(topic, data, compress);
  }

  /** The same envelope `@OnMessage(event)` reads, published to a topic. */
  publishEvent(topic: string, event: string, data?: unknown): number {
    return this.publish(topic, encode(event, data));
  }

  subscriberCount(topic: string): number {
    return this.#live().subscriberCount(topic);
  }

  #live(): Server<SocketData> {
    if (!this.#server) {
      throw new AppError(
        'PubSub has no server yet. Publish once the server is listening: ' +
          'HttpApp.listen() is what attaches it.',
      );
    }
    return this.#server;
  }
}
