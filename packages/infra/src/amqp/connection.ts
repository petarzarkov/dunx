import { Logger, type OnShutdown } from '@dunx/core';
import { AmqpError, AmqpErrorCode } from './errors.js';
import {
  Connection,
  type Consumer,
  type ConsumerHandler,
  type ConsumerProps,
  type Publisher,
  type PublisherProps,
} from 'rabbitmq-client';
import { AmqpOptions } from './options.js';

/**
 * How long `Connection.close()` gets before shutdown stops waiting. It waits for
 * every open channel, and one whose broker has gone away takes `acquireTimeout`,
 * 20 s by default. `unsafeDestroy()` follows regardless.
 */
const CLOSE_TIMEOUT_MS = 5_000;

/**
 * The one connection this app holds, and the only place `rabbitmq-client` is
 * constructed. One TCP connection carries a channel per consumer and one for the
 * publisher; channels are multiplexed, so a connection each would cost a socket
 * and a heartbeat for nothing.
 *
 * Opened on first use, so a process that neither publishes nor consumes holds no
 * socket and exits without being told to.
 */
export class AmqpConnection implements OnShutdown {
  readonly #options: AmqpOptions;
  readonly #logger: Logger;
  #connection: Connection | undefined;
  #closed = false;

  constructor(options: AmqpOptions, logger: Logger) {
    this.#options = options;
    this.#logger = logger;
  }

  /** Whether a socket has been opened at all. */
  get opened(): boolean {
    return this.#connection !== undefined;
  }

  /** Whether the broker is reachable right now. False before the first use. */
  get ready(): boolean {
    return this.#connection?.ready === true;
  }

  /**
   * The live `Connection`, opened on the first call. Returned rather than
   * wrapped, for the reason `JobPublisher.queue()` hands back a bullmq `Queue`:
   * `queueDeclare`, `basicGet` and `createRPCClient` are already there.
   */
  connection(): Connection {
    const existing = this.#connection;
    if (existing) return existing;
    // Reopening after teardown would put a socket back that nothing will close,
    // and the process would then not exit. A publish from a provider torn down
    // out of order fails here instead, naming what happened.
    if (this.#closed) {
      throw new AmqpError(
        AmqpErrorCode.INVALID_STATE,
        'The AMQP connection has been closed by container shutdown. Something ' +
          'published or subscribed after teardown.',
      );
    }

    const created = new Connection({
      ...this.#options.connection,
      url: this.#options.url,
      connectionName: this.#options.connectionName,
    });

    // An 'error' event with no listener throws rather than being ignored, so an
    // unreachable broker would take the process down on its first retry instead
    // of reconnecting quietly behind this line.
    created.on('error', (error: unknown) => {
      this.#logger.warn('the AMQP connection reported an error', error);
    });
    created.on('connection', () => {
      this.#logger.debug(`AMQP connected to ${this.#options.redactedUrl}`);
    });
    // The broker is out of memory or disk and has stopped reading from the
    // socket. Published messages pile up in this process until it says otherwise.
    created.on('connection.blocked', (reason: string) => {
      this.#logger.warn(`the AMQP broker blocked this connection: ${reason}`);
    });
    created.on('connection.unblocked', () => {
      this.#logger.info('the AMQP broker unblocked this connection');
    });

    this.#connection = created;
    return created;
  }

  /** A consumer on its own channel, recreated by the library on every reconnect.
   * `AmqpSubscriber` owns every one and stops them before this closes. */
  createConsumer(props: ConsumerProps, handler: ConsumerHandler): Consumer {
    return this.connection().createConsumer(props, handler);
  }

  /** A publisher on its own channel. `AmqpPublisher` owns the one this app has. */
  createPublisher(props: PublisherProps): Publisher {
    return this.connection().createPublisher(props);
  }

  /**
   * Closes the connection, last in reverse-order teardown: the consumers and the
   * publisher are constructed after this and torn down before it, leaving
   * `close()` no channel to wait for. `unsafeDestroy()` follows either way, since
   * a socket still open is what keeps the process from exiting.
   */
  async onShutdown(): Promise<void> {
    const connection = this.#connection;
    this.#closed = true;
    if (connection === undefined) return;
    this.#connection = undefined;

    const timedOut = Symbol('timed out');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        connection.close(),
        new Promise<symbol>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), CLOSE_TIMEOUT_MS);
        }),
      ]);
      if (outcome === timedOut) {
        this.#logger.warn(
          `the AMQP connection did not close within ${CLOSE_TIMEOUT_MS} ms`,
        );
      }
    } catch (error) {
      this.#logger.warn('the AMQP connection failed to close', error);
    } finally {
      // The loser of the race stays pending: a `Bun.sleep` here would hold the
      // loop open for the whole window on every clean shutdown.
      clearTimeout(timer);
      connection.unsafeDestroy();
    }
  }
}
