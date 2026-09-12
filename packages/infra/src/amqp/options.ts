import type {
  ConnectionOptions,
  ConsumerProps,
  PublisherProps,
} from 'rabbitmq-client';
import { redactUrl } from '../redis/options.js';
import { AmqpError, AmqpErrorCode } from './errors.js';

/** The two schemes AMQP 0-9-1 defines. `amqps:` is the same protocol over TLS. */
export const AMQP_PROTOCOLS = Object.freeze(['amqp:', 'amqps:'] as const);

export type AmqpProtocol = (typeof AMQP_PROTOCOLS)[number];

/** `$RABBITMQ_URL`, then `$AMQP_URL`, then the broker's own default. */
export const defaultAmqpUrl = (): string =>
  process.env['RABBITMQ_URL'] ??
  process.env['AMQP_URL'] ??
  'amqp://guest:guest@localhost:5672';

/**
 * Checked here rather than at connect time: `rabbitmq-client` retries a failed
 * connection forever, so a typo in the scheme would surface as a publish that
 * never settles.
 *
 * **Neither message carries the url as given.** An AMQP url almost always holds
 * credentials, a boot error is written by whatever logger is bound, and an
 * unparseable one cannot be redacted at all, since `redactUrl` parses it too.
 */
export const assertAmqpUrl = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AmqpError(
      AmqpErrorCode.INVALID_URL,
      'The AMQP url is not a valid URL. Expected something like ' +
        'amqp://guest:guest@localhost:5672. Check $RABBITMQ_URL, $AMQP_URL, or ' +
        'the `url` passed to AmqpModule.',
    );
  }

  if (!(AMQP_PROTOCOLS as readonly string[]).includes(parsed.protocol)) {
    throw new AmqpError(
      AmqpErrorCode.INVALID_URL,
      `Unsupported protocol ${JSON.stringify(parsed.protocol)} in ` +
        `${redactUrl(url)}. Expected one of ${AMQP_PROTOCOLS.join(', ')}.`,
    );
  }

  return url;
};

/** What `AmqpConnection` sets itself, so it is not yours to pass. */
export type ConnectionPassthrough = Omit<
  ConnectionOptions,
  'url' | 'connectionName'
>;

/** What a handler's own `consumer` field sets, so it is not yours to pass here. */
export type ConsumerPassthrough = Omit<ConsumerProps, 'queue'>;

export interface AmqpOptionsInit {
  /** Defaults to `$RABBITMQ_URL`, `$AMQP_URL`, then `amqp://guest:guest@localhost:5672`. */
  readonly url?: string;
  /** Shown in the broker's management UI. @default 'dunx' */
  readonly connectionName?: string;
  /**
   * Forwarded verbatim to `rabbitmq-client`'s `Connection` - `heartbeat`,
   * `frameMax`, `retryLow`, `tls`, `hosts` and the rest.
   */
  readonly connection?: ConnectionPassthrough;
  /**
   * The default for every consumer this app opens, overridable per handler.
   * `prefetchCount` is twice `concurrency` on the library's own advice, and
   * `durable` is on because RabbitMQ 4 refuses a `transient_nonexcl_queue` with
   * `INTERNAL_ERROR` at declare time.
   *
   * @default { concurrency: 8, qos: { prefetchCount: 16 }, queueOptions: { durable: true } }
   */
  readonly consumer?: ConsumerPassthrough;
  /** Forwarded verbatim to the one `Publisher` this app opens. */
  readonly publisher?: PublisherProps;
  /**
   * How long `start()` waits for each consumer to report itself set up before
   * logging that it has not and carrying on. `rabbitmq-client` retries a failed
   * setup forever, so this bounds how long boot blocks rather than whether the
   * consumer works.
   *
   * @default 5000
   */
  readonly readyTimeoutMs?: number;
  /**
   * How long `stop()` waits for each consumer to drain. `Consumer.close()`
   * settles every in-flight handler and then closes the channel, so against a
   * broker that has gone away it waits `connection.acquireTimeout`: 19.7 s
   * measured on rabbitmq-client 5.0.8, with nothing in flight. The connection is
   * destroyed afterwards either way. Raise this above the longest handler here.
   *
   * @default 10000
   */
  readonly drainTimeoutMs?: number;
  /**
   * How long `AmqpConnection.onShutdown` waits for the connection to close before
   * destroying the socket. `close()` waits for every open channel, and one whose
   * broker has gone away takes `acquireTimeout`. The socket is destroyed after
   * this either way.
   *
   * @default 5000
   */
  readonly closeTimeoutMs?: number;
  /**
   * Reject a handler that runs longer than this, so a message hung on an external
   * call is nacked instead of holding a prefetch slot forever. AMQP has no
   * handler timeout of its own. Off by default.
   */
  readonly handlerTimeoutMs?: number;
  /**
   * Open consumers in **this** process, rather than only binding the publish side.
   * Off by default: `AmqpModule` is imported by anything that publishes, and a
   * web process that started consuming to send a message would be a surprise.
   *
   * On, the container owns them - started at `onInit`, stopped at `onShutdown`,
   * which runs before the connection the handlers use closes. `'if-any'` stands
   * down with a warning where `true` fails boot.
   */
  readonly consume?: boolean | 'if-any';
}

/**
 * A class, not an interface, so it is a runtime value and can therefore be a
 * constructor parameter type that `@dunx/transform` can record.
 */
export class AmqpOptions {
  readonly url: string;
  readonly connectionName: string;
  readonly connection: ConnectionPassthrough;
  readonly consumer: ConsumerPassthrough;
  readonly publisher: PublisherProps;
  readonly readyTimeoutMs: number;
  readonly drainTimeoutMs: number;
  readonly closeTimeoutMs: number;
  readonly handlerTimeoutMs: number | undefined;
  readonly consume: boolean | 'if-any';

  constructor(init: AmqpOptionsInit = {}) {
    this.url = assertAmqpUrl(init.url ?? defaultAmqpUrl());
    this.connectionName = init.connectionName ?? 'dunx';
    this.connection = init.connection ?? {};
    const given = init.consumer ?? {};
    // `qos` and `queueOptions` merge key by key. A single spread replaced them
    // wholesale, so `queueOptions: { arguments: ... }` dropped `durable: true`
    // and RabbitMQ 4 refuses the declare, and a partial `qos` reset the prefetch.
    this.consumer = {
      concurrency: 8,
      ...given,
      qos: { prefetchCount: 16, ...given.qos },
      queueOptions: { durable: true, ...given.queueOptions },
    };
    // Without confirms `send()` resolves once the frame is written, so a broker
    // that rejected the message reports nothing.
    this.publisher = { confirm: true, ...init.publisher };
    this.readyTimeoutMs = init.readyTimeoutMs ?? 5_000;
    this.drainTimeoutMs = init.drainTimeoutMs ?? 10_000;
    this.closeTimeoutMs = init.closeTimeoutMs ?? 5_000;
    this.handlerTimeoutMs = init.handlerTimeoutMs;
    this.consume = init.consume ?? false;
  }

  /** The URL with any password removed, for logs and error messages. */
  get redactedUrl(): string {
    return redactUrl(this.url);
  }
}
