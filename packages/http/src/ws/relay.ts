/**
 * What `PubSub` needs from something that carries a message to the other nodes:
 * publish, and subscribe. Nothing else, so anything that already talks to a
 * broker satisfies it — `@dunx/infra/redis`'s `RedisConnection` does, structurally
 * and with no adapter, and so does a bare `Bun.RedisClient` pair.
 *
 * The return types are `unknown` rather than `Promise<void>` deliberately: Bun's
 * `publish` resolves the subscriber count, `@dunx/infra`'s resolves nothing, and a
 * synchronous in-memory bus resolves at all. A returned promise is awaited by
 * `subscribe` and watched for rejection by `publish`; anything else is taken as
 * having succeeded.
 */
export interface PubSubRelay {
  /** Hand `message` to every node subscribed to `channel`, this one included. */
  publish(channel: string, message: string): unknown;
  /**
   * Deliver every message published to `channel` to `listener`. Called once, with
   * one channel — pattern subscription is not used, because Bun's `psubscribe`
   * does not work (see docs/bun-apis.md).
   */
  subscribe(channel: string, listener: (message: string) => void): unknown;
  /**
   * Release whatever this relay opened. Implement it only for connections the
   * relay itself owns: a relay that is the application's own shared
   * `RedisConnection` must leave closing to the container, and simply omitting
   * this method is how it says so.
   */
  close?(): unknown;
}

/** Which relay call failed, so one message can say what degraded. */
export type RelayPhase = 'publish' | 'subscribe' | 'close';

export interface RelayOptions {
  /**
   * The one broker channel every topic's frames travel on.
   *
   * One channel rather than one per topic, because a node cannot know which
   * topics its sockets joined — `socket.subscribe()` goes straight into Bun — and
   * `psubscribe` is unusable. The cost is that every node reads every relayed
   * frame and drops the ones for topics it has no local subscriber on, which is a
   * `server.publish` returning `0`. Two apps sharing a Redis need two channels.
   *
   * @default 'dunx:ws'
   */
  readonly channel?: string;
  /**
   * Where a relay failure goes. Called once when the relay starts failing and not
   * again until it works, so an unreachable broker cannot flood the log.
   *
   * @default console.warn
   */
  readonly onError?: (error: unknown, phase: RelayPhase) => void;
  /**
   * What to do when the **boot** subscribe fails. Publishing recovers on its own —
   * every publish retries the broker — but a failed subscribe used to be retried
   * by nothing, so the node stayed permanently deaf to other nodes while still
   * looking healthy.
   *
   * Bounded rather than infinite, and the timer is unref'd, so a broker that never
   * comes back cannot hold the process open or spin forever.
   */
  readonly resubscribe?: {
    /** Retries after the first failure. `0` disables them. @default 5 */
    readonly attempts?: number;
    /** First delay; doubles each attempt, capped at 30s. @default 500 */
    readonly delayMs?: number;
  };
}

export const DEFAULT_RELAY_CHANNEL = 'dunx:ws';

export const defaultRelayError = (error: unknown, phase: RelayPhase): void => {
  console.warn(
    `[dunx/http] the websocket relay could not ${phase}. Fan-out is local to ` +
      'this process until it recovers:',
    error,
  );
};

/**
 * One relayed publish: which process published it, which topic it belongs to, and
 * the frame itself. `origin` is the whole duplicate-delivery defence — the broker
 * echoes a publish back to the publisher, and fanning that out locally a second
 * time would give every client on the originating node the message twice.
 */
export interface RelayFrame {
  readonly origin: string;
  readonly topic: string;
  readonly data: string | Uint8Array<ArrayBufferLike>;
}

const toBytes = (data: Bun.BufferSource): Uint8Array<ArrayBufferLike> =>
  ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);

export const encodeRelay = (
  origin: string,
  topic: string,
  data: string | Bun.BufferSource,
): string =>
  typeof data === 'string'
    ? JSON.stringify({ o: origin, t: topic, d: data })
    : // Base64 through Buffer, which Bun implements natively. A binary frame has
      // to survive a text channel, and Redis pub/sub payloads are text here
      // because Bun's buffer-mode subscription is not implemented.
      JSON.stringify({
        o: origin,
        t: topic,
        d: Buffer.from(toBytes(data)).toString('base64'),
        b: 1,
      });

/** `undefined` for anything that is not one of our frames, which is then ignored. */
export const decodeRelay = (message: string): RelayFrame | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const { o, t, d, b } = parsed as {
    o?: unknown;
    t?: unknown;
    d?: unknown;
    b?: unknown;
  };
  if (typeof o !== 'string' || typeof t !== 'string' || typeof d !== 'string') {
    return undefined;
  }
  return { origin: o, topic: t, data: b ? Buffer.from(d, 'base64') : d };
};
