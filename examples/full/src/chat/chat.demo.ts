import { Logger, Module } from '@dunx/core';
import { HttpFactory, PubSub, type HttpApp } from '@dunx/http';
import { isConnectionError, RedisConnection } from '@dunx/infra/redis';
import { RELAY_CHANNEL } from '../config.js';
import { ChatGateway } from './chat.gateway.js';
import { Lobby } from './lobby.service.js';

interface Client {
  next(): Promise<string>;
  send(event: string, data: unknown): void;
  close(): void;
  /** Every frame this socket ever received, so a *second* delivery is visible. */
  readonly received: readonly string[];
}

/** A real `new WebSocket()`, with a deadline so a stall fails instead of hanging. */
const connect = async (base: string): Promise<Client> => {
  const socket = new WebSocket(
    new URL('chat', base).href.replace('http', 'ws'),
  );
  const frames: string[] = [];
  const received: string[] = [];
  const waiting: ((frame: string) => void)[] = [];

  socket.addEventListener('message', (event: MessageEvent) => {
    const frame = String(event.data);
    received.push(frame);
    const waiter = waiting.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    setTimeout(() => reject(new Error('the socket never opened')), 2000);
  });

  return {
    next: () =>
      new Promise<string>((resolve, reject) => {
        const queued = frames.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error('no frame arrived')),
          2000,
        );
        waiting.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      }),
    send: (event, data) => socket.send(JSON.stringify({ event, data })),
    close: () => socket.close(),
    received,
  };
};

/**
 * A second node in-process: two `Bun.serve` instances, two containers, two
 * `PubSub` origin ids. It reuses the same `ChatGateway` and excludes `ChatDemo`,
 * so it cannot recurse.
 */
@Module({ providers: [ChatGateway, Lobby] })
class PeerNode {}

export class ChatDemo {
  constructor(
    private readonly pubsub: PubSub,
    private readonly logger: Logger,
    private readonly redis: RedisConnection,
  ) {}

  async demonstrate(app: HttpApp, url: string): Promise<void> {
    const { logger } = this;
    logger.info(
      `gateway paths: ${JSON.stringify(app.gatewayPaths)} - setGlobalPrefix moves routes, not gateways`,
    );

    const [ada, grace] = await Promise.all([connect(url), connect(url)]);
    logger.info(
      `two clients connected: ${await ada.next()} / ${await grace.next()}`,
    );

    ada.send('say', 'one server, two protocols');
    logger.info(
      `grace <- ${await grace.next()} (the broadcast, Bun native pub/sub)`,
    );
    logger.info(
      `ada   <- ${await ada.next()} (a server publish reaches the sender too)`,
    );
    logger.info(
      `ada   <- ${await ada.next()} (then what the handler returned, as a reply)`,
    );
    logger.info(
      `"${Lobby.TOPIC}" subscribers: ${this.pubsub.subscriberCount(Lobby.TOPIC)}`,
    );

    const alsoHttp = await fetch(new URL('api/notes', url));
    logger.info(
      `the same server still answers GET /api/notes -> ${alsoHttp.status}`,
    );

    ada.close();
    grace.close();
    await Bun.sleep(20);
  }

  /**
   * A publish on one node reaching a client connected to the other, exactly once.
   * Node A relays through `RedisRelay`; node B through its own `RedisConnection`,
   * which satisfies `PubSubRelay` structurally with no adapter.
   */
  async relayed(url: string): Promise<void> {
    const { logger } = this;
    if (!(await this.#redisUp())) {
      logger.warn('skipping the relay demo: no Redis to relay through');
      logger.info(
        'the app booted anyway and fan-out stayed local - that is the degraded path',
      );
      return;
    }

    const peer = await HttpFactory.create(PeerNode, { requestLogging: false });
    const peerUrl = await peer.listen(0);
    const peerPubsub = peer.get(PubSub);
    await peerPubsub.relayThrough(this.redis, { channel: RELAY_CHANNEL });

    try {
      logger.info(`node A on ${url}, node B on ${peerUrl}`);
      // The last chars: a v7 uuid leads with a timestamp, so two minted in the
      // same second share their leading digits.
      logger.info(
        `origins: A …${this.pubsub.origin.slice(-6)} / B …${peerPubsub.origin.slice(-6)} ` +
          '- what tells a node its own echoed frame',
      );

      const [onA, onB] = await Promise.all([connect(url), connect(peerUrl)]);
      await Promise.all([onA.next(), onB.next()]);

      const said = 'across nodes';
      this.pubsub.publishEvent(Lobby.TOPIC, 'said', said);
      logger.info(`node B's client <- ${await onB.next()} (relayed via Redis)`);
      // Redis echoes a publish back to its publisher; the origin check drops it
      // so node A does not deliver twice.
      await Bun.sleep(200);
      const delivered = (client: Client): number =>
        client.received.filter((frame) => frame.includes(said)).length;
      logger.info(
        `deliveries of "${said}": A ${delivered(onA)}, B ${delivered(onB)} ` +
          '(one each - the echo was dropped, not fanned out again)',
      );

      onA.close();
      onB.close();
      await Bun.sleep(20);
    } finally {
      await peer.shutdown();
    }
  }

  /** A relay demo needs a broker; an absent one is a skip, not a failure. */
  async #redisUp(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      return false;
    }
  }
}
