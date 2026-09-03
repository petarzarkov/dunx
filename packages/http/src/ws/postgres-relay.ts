import { assertRelayUrl, redactUrl, WsRelay } from './relay.js';

/** The schemes `Bun.SQL` accepts for its Postgres adapter. */
const PROTOCOLS: readonly string[] = ['postgres:', 'postgresql:'];

/** The same fallback chain `Bun.SQL` uses when given no URL. */
const defaultPostgresRelayUrl = (): string =>
  process.env['POSTGRES_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://localhost:5432';

export interface PostgresRelayOptions {
  /** @default `$POSTGRES_URL`, `$DATABASE_URL`, then `postgres://localhost:5432` */
  readonly url?: string;
  /**
   * Size of the query pool `notify` publishes through. **`subscribe` opens a
   * dedicated connection on top of it**, so a relay that is listening holds up to
   * `max + 1`. Measured: `max: 1` shows two rows in `pg_stat_activity`.
   *
   * @default 1
   */
  readonly max?: number;
}

/**
 * A {@link WsRelay} on `Bun.SQL`'s `LISTEN`/`NOTIFY`, a Bun global, so it costs
 * `@dunx/http` no dependency and an app already on Postgres needs no broker.
 *
 * One client, two connections while it listens: Bun dedicates one to the `LISTEN`
 * and leaves the pool to answer `notify`. Budget `max + 1` per replica.
 *
 * **A frame over about 7.9 KB is refused**, because Postgres caps a `NOTIFY`
 * payload at 7999 bytes and the relay envelope adds to the frame. `PubSub` reports
 * one `logger.warn` and fan-out stays local for that message. Redis has no
 * comparable ceiling; measured in docs/architecture/http.md.
 *
 * Reconnection is Bun's, so there is no retry budget here.
 */
export class PostgresRelay extends WsRelay {
  readonly #url: string;
  readonly #max: number;
  #sql: Bun.SQL | undefined;
  #subscription: { unlisten(): Promise<void> } | undefined;

  constructor(options: PostgresRelayOptions = {}) {
    super();
    this.#url = assertRelayUrl(
      options.url ?? defaultPostgresRelayUrl(),
      PROTOCOLS,
      'postgres://localhost:5432/app',
    );
    this.#max = options.max ?? 1;
  }

  /** The URL with any password removed, for logs and error messages. */
  get url(): string {
    return redactUrl(this.#url);
  }

  #client(): Bun.SQL {
    return (this.#sql ??= new Bun.SQL({ url: this.#url, max: this.#max }));
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.#client().notify(channel, message);
  }

  async subscribe(
    channel: string,
    listener: (message: string) => void,
  ): Promise<void> {
    const sql = this.#client();
    try {
      this.#subscription = await sql.listen(channel, listener);
    } catch (error) {
      if (this.#sql === sql) {
        this.#sql = undefined;
        await sql.close();
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    const sql = this.#sql;
    const subscription = this.#subscription;
    this.#sql = undefined;
    this.#subscription = undefined;
    if (subscription) {
      try {
        await subscription.unlisten();
      } catch {
        // A connection that is already gone is not listening either, and throwing
        // here would leave the client below unclosed.
      }
    }
    await sql?.close();
  }
}
