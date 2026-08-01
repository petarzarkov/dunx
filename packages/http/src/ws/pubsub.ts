import { AppError } from '@dunx/core';
import type { Server } from 'bun';
import { encode } from './envelope.js';
import {
  decodeRelay,
  DEFAULT_RELAY_CHANNEL,
  defaultRelayError,
  encodeRelay,
  type PubSubRelay,
  type RelayOptions,
  type RelayPhase,
} from './relay.js';
import type { SocketData } from './socket.js';

/**
 * Server-wide publish, delegating to Bun's own pub/sub. Topics live in the
 * runtime, not in a JavaScript registry: `socket.subscribe(topic)` is what joins
 * one, and Bun does the fan-out.
 *
 * Injectable — `HttpFactory` binds it, so a service can publish without holding a
 * socket and without registering anything.
 *
 * With a {@link PubSubRelay} attached the same publish also reaches the other
 * nodes. Without one — the default — nothing here touches a broker and the cost is
 * exactly Bun's.
 */
export class PubSub {
  /**
   * Identifies this process on the wire, so a frame this node published and the
   * broker echoed back is recognised and dropped instead of being fanned out
   * locally a second time. `Bun.randomUUIDv7` rather than a counter: two nodes
   * booted in the same millisecond must not collide.
   */
  readonly #origin = Bun.randomUUIDv7();
  #server: Server<SocketData> | undefined;
  #relay: PubSubRelay | undefined;
  #channel = DEFAULT_RELAY_CHANNEL;
  #onRelayError = defaultRelayError;
  /** So a broker that is down is reported once, not once per publish. */
  #relayFailing = false;

  /** Called with the live server by `listen()`; also usable directly. */
  attach(server: Server<SocketData>): void {
    this.#server = server;
  }

  get attached(): boolean {
    return this.#server !== undefined;
  }

  /** This process's id on the relay channel. Stable for the process's lifetime. */
  get origin(): string {
    return this.#origin;
  }

  get relaying(): boolean {
    return this.#relay !== undefined;
  }

  /**
   * Opt into multi-node fan-out: every `publish` from here on also goes to
   * `relay`, and everything other nodes put on the channel is fanned out locally.
   *
   * `HttpFactory.create(root, { relay })` is the shorthand — `listen()` calls this.
   * Call it directly when the relay has to come out of the container, which is the
   * case for an app reusing its own `@dunx/infra/redis` connection:
   * `app.get(PubSub).relayThrough(app.get(RedisConnection))` before `listen()`.
   *
   * A broker that cannot be reached is reported through `onError` and left alone —
   * local fan-out is unaffected, and the app boots either way.
   */
  async relayThrough(
    relay: PubSubRelay,
    options: RelayOptions = {},
  ): Promise<void> {
    if (this.#relay) {
      throw new AppError(
        'PubSub already relays. Two subscriptions on one channel would deliver ' +
          'every relayed message twice — pass HttpOptions.relay or call ' +
          'relayThrough(), not both.',
      );
    }
    this.#relay = relay;
    this.#channel = options.channel ?? DEFAULT_RELAY_CHANNEL;
    this.#onRelayError = options.onError ?? defaultRelayError;

    try {
      // Bun's client throws synchronously for some states, so the call is inside
      // the try rather than only the await.
      await relay.subscribe(this.#channel, (message) => {
        this.#inbound(message);
      });
      this.#relayFailing = false;
    } catch (error) {
      this.#degrade(error, 'subscribe');
    }
  }

  /** Bytes sent locally, `0` if the message was dropped, `-1` under backpressure. */
  publish(
    topic: string,
    data: string | Bun.BufferSource,
    compress?: boolean,
  ): number {
    const sent = this.#live().publish(topic, data, compress);
    // Unconditional, and after the local fan-out: a topic with no subscriber on
    // this node may have thousands on another.
    this.#outbound(topic, data);
    return sent;
  }

  /** The same envelope `@OnMessage(event)` reads, published to a topic. */
  publishEvent(topic: string, event: string, data?: unknown): number {
    return this.publish(topic, encode(event, data));
  }

  /** Subscribers on **this** node. Bun counts its own sockets and nothing else. */
  subscriberCount(topic: string): number {
    return this.#live().subscriberCount(topic);
  }

  /**
   * Releases a relay this `PubSub` was given, if the relay owns connections.
   *
   * The server reference goes too, which is what makes a relay the *app* owns safe
   * to leave subscribed: `PubSubRelay` has no unsubscribe, so a frame may still
   * arrive on a shared connection after this node stopped, and with no server
   * there is nothing for it to fan out to.
   */
  async close(): Promise<void> {
    const relay = this.#relay;
    this.#relay = undefined;
    this.#server = undefined;
    if (!relay?.close) return;
    try {
      await relay.close();
    } catch (error) {
      this.#degrade(error, 'close');
    }
  }

  #outbound(topic: string, data: string | Bun.BufferSource): void {
    const relay = this.#relay;
    if (!relay) return;
    try {
      const result = relay.publish(
        this.#channel,
        encodeRelay(this.#origin, topic, data),
      );
      if (result instanceof Promise) {
        void result.then(
          () => {
            this.#relayFailing = false;
          },
          (error: unknown) => {
            this.#degrade(error, 'publish');
          },
        );
        return;
      }
      this.#relayFailing = false;
    } catch (error) {
      this.#degrade(error, 'publish');
    }
  }

  /**
   * Local fan-out only, and that is the whole rule: republishing to the relay here
   * would put the frame back on the channel that delivered it and loop forever.
   */
  #inbound(message: string): void {
    const frame = decodeRelay(message);
    if (!frame || frame.origin === this.#origin) return;
    this.#server?.publish(frame.topic, frame.data);
  }

  #degrade(error: unknown, phase: RelayPhase): void {
    if (this.#relayFailing) return;
    this.#relayFailing = true;
    this.#onRelayError(error, phase);
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
