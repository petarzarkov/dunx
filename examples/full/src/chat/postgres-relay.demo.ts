import { Logger, Module, provide } from '@dunx/core';
import {
  HttpFactory,
  HttpOptionsProvider,
  PubSub,
  WsRelay,
  WsRelayModule,
  type PubSubRelay,
} from '@dunx/http';
import { RELAY_CHANNEL } from '../config.js';
import { ChatGateway } from './chat.gateway.js';
import { Lobby } from './lobby.service.js';
import { connect } from './ws-client.js';

/**
 * Read here rather than injected: the module is declared at file scope, so it
 * cannot reach `ConfigService`. The default matches `compose.yml` and the schema's.
 */
const POSTGRES_URL =
  Bun.env['POSTGRES_URL'] ?? 'postgres://dunx:dunx@localhost:5432/dunx';

/**
 * The same fan-out as the Redis relay, over `Bun.SQL`'s `LISTEN`/`NOTIFY`, for an
 * app that already has Postgres and would rather not run a broker.
 *
 * Two nodes, each with its own `WsRelayModule.forPostgres` and its own `PubSub`
 * origin. Neither shares a container with the other, which is what makes the
 * delivery real rather than a same-process shortcut.
 */
/**
 * Binding the relay is not the same as using it. `WsRelayModule` puts a `WsRelay`
 * in the container; what attaches it to `PubSub` is an `HttpOptionsProvider`
 * answering `relay`, exactly as `AppHttpOptions` does for the app itself. Without
 * this the nodes come up, the sockets work, and every publish stays local.
 */
class NodeHttpOptions extends HttpOptionsProvider {
  constructor(private readonly bus: WsRelay) {
    super();
  }

  override get relay(): PubSubRelay {
    return this.bus;
  }

  override readonly relayChannel = RELAY_CHANNEL;
}

@Module({
  imports: [WsRelayModule.forPostgres({ url: POSTGRES_URL })],
  providers: [
    ChatGateway,
    Lobby,
    // Bound to the token `HttpFactory` asks for, not registered as itself:
    // the factory looks up `HttpOptionsProvider` and promotes a default when
    // nothing answers it, so a bare subclass in `providers` is never consulted.
    provide(HttpOptionsProvider, { useClass: NodeHttpOptions }),
  ],
})
class PostgresNode {}

/** Postgres caps a `NOTIFY` payload at 7999 bytes, envelope included. */
const OVER_THE_NOTIFY_CAP = 9000;

export class PostgresRelayDemo {
  constructor(private readonly logger: Logger) {}

  async demonstrate(): Promise<void> {
    const { logger } = this;
    if (!(await this.#postgresUp())) {
      logger.warn(
        `skipping the Postgres relay demo: nothing answering at ${POSTGRES_URL}`,
      );
      logger.info('`bun run services:up` starts it, and CI runs the same file');
      return;
    }

    const [a, b] = await Promise.all([this.#node(), this.#node()]);
    try {
      logger.info(
        `two nodes on LISTEN/NOTIFY, origins …${a.pubsub.origin.slice(-6)} / …${b.pubsub.origin.slice(-6)}`,
      );

      const [onA, onB] = await Promise.all([connect(a.url), connect(b.url)]);
      await Promise.all([onA.next(), onB.next()]);

      const said = 'across nodes, over Postgres';
      a.pubsub.publishEvent(Lobby.TOPIC, 'said', said);
      logger.info(
        `node B's client <- ${await onB.next()} (relayed via NOTIFY)`,
      );

      await Bun.sleep(250);
      const seen = (frames: readonly string[]): number =>
        frames.filter((frame) => frame.includes(said)).length;
      logger.info(
        `deliveries: A ${seen(onA.received)}, B ${seen(onB.received)} ` +
          '(one each, so the publisher did not fan its own frame out twice)',
      );

      // Postgres refuses the NOTIFY rather than truncating it. The publish is
      // reported and fan-out stays local, which is the documented degradation.
      const huge = 'x'.repeat(OVER_THE_NOTIFY_CAP);
      a.pubsub.publishEvent(Lobby.TOPIC, 'said', huge);
      await Bun.sleep(400);
      const huge_ = (frames: readonly string[]): number =>
        frames.filter((frame) => frame.includes(huge)).length;
      logger.info(
        `a ${OVER_THE_NOTIFY_CAP}-byte frame: A ${huge_(onA.received)}, B ${huge_(onB.received)} ` +
          '(over the 7999-byte NOTIFY cap, so the publishing node still delivers ' +
          'it and the relay reports one warn)',
      );

      onA.close();
      onB.close();
      await Bun.sleep(20);
    } finally {
      await Promise.all([a.app.shutdown(), b.app.shutdown()]);
    }
  }

  async #node(): Promise<{
    app: Awaited<ReturnType<typeof HttpFactory.create>>;
    url: string;
    pubsub: PubSub;
  }> {
    const app = await HttpFactory.create(PostgresNode, {
      requestLogging: false,
    });
    const url = await app.listen(0);
    return { app, url, pubsub: app.get(PubSub) };
  }

  /** A relay demo needs its backend; an absent one is a skip, not a failure. */
  async #postgresUp(): Promise<boolean> {
    const sql = new Bun.SQL(POSTGRES_URL, {
      max: 1,
      connectionTimeout: 2,
    });
    try {
      await sql`select 1`;
      return true;
    } catch {
      return false;
    } finally {
      await sql.close().catch(() => undefined);
    }
  }
}
