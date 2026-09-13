import { encode } from './envelope.js';
import {
  DEFAULT_RELAY_CHANNEL,
  defaultRelayError,
  encodeRelay,
  WsRelay,
  type RelayOptions,
} from './relay.js';

/** What a publisher needs beyond the relay itself. */
export interface RelayPublisherInit {
  /**
   * The broker channel, which **must** be the one the servers listen on
   * (`HttpOptionsProvider.relayChannel`). A mismatch is silent - the broker
   * accepts the publish and delivers it to nobody - so read both from one
   * constant rather than writing the name twice.
   */
  readonly channel?: string;
  /** Reports a publish the broker refused. Defaults to a `console.warn`. */
  readonly onError?: RelayOptions['onError'];
}

/**
 * Publishes a socket frame from a process that has no server.
 *
 * `PubSub` needs a live `Bun.serve` for the local half of its fan-out, which a
 * queue worker or a forked job child has none of. This is the other half alone:
 * every frame goes to the broker and comes back out of the servers listening on
 * the channel, with no local delivery and no subscribe.
 *
 * `WsRelayModule` binds it, so it is a constructor parameter:
 *
 * ```ts
 * export class RoundAnnouncer {
 *   constructor(private readonly frames: RelayPublisher) {}
 *
 *   announce(round: string): void {
 *     this.frames.publishEvent('lobby', 'round.started', { round });
 *   }
 * }
 * ```
 */
export class RelayPublisher {
  /**
   * Identifies this process on the wire. A server drops a frame carrying its own
   * origin and no server has this one, so every node fans this out.
   */
  readonly #origin = `worker:${Bun.randomUUIDv7()}`;
  readonly #channel: string;
  readonly #onError: NonNullable<RelayOptions['onError']>;

  constructor(
    private readonly relay: WsRelay,
    init: RelayPublisherInit = {},
  ) {
    this.#channel = init.channel ?? DEFAULT_RELAY_CHANNEL;
    this.#onError = init.onError ?? defaultRelayError;
  }

  /** This process's id on the relay channel. Stable for its lifetime. */
  get origin(): string {
    return this.#origin;
  }

  /** The channel frames go out on. */
  get channel(): string {
    return this.#channel;
  }

  /** The same envelope `@OnMessage(event)` reads, published to a topic. */
  publishEvent(topic: string, event: string, data?: unknown): void {
    this.publish(topic, encode(event, data));
  }

  /**
   * **Never throws.** A job handler that failed here would be retried and would
   * repeat its side effects to deliver a frame nobody awaited. Failures go to
   * `onError`.
   */
  publish(topic: string, data: string | Bun.BufferSource): void {
    try {
      const result = this.relay.publish(
        this.#channel,
        encodeRelay(this.#origin, topic, data),
      );
      if (result instanceof Promise) {
        void result.catch((error: unknown) => {
          this.#report(error);
        });
      }
    } catch (error) {
      this.#report(error);
    }
  }

  /** `onError` is the caller's code, so it can throw. Not out of here. */
  #report(error: unknown): void {
    try {
      this.#onError(error, 'publish');
    } catch (failure) {
      console.error(
        '[dunx/http] a RelayPublisher onError handler threw:',
        failure,
      );
    }
  }
}
