import { Logger } from '@dunx/core';
import { PubSub, type HttpApp } from '@dunx/http';
import { Lobby } from './lobby.service.js';

interface Client {
  next(): Promise<string>;
  send(event: string, data: unknown): void;
  close(): void;
}

/** A real `new WebSocket()`, with a deadline so a stall fails instead of hanging. */
const connect = async (base: string): Promise<Client> => {
  const socket = new WebSocket(
    new URL('chat', base).href.replace('http', 'ws'),
  );
  const frames: string[] = [];
  const waiting: ((frame: string) => void)[] = [];

  socket.addEventListener('message', (event: MessageEvent) => {
    const frame = String(event.data);
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
  };
};

export class ChatDemo {
  constructor(
    private readonly pubsub: PubSub,
    private readonly logger: Logger,
  ) {}

  async demonstrate(app: HttpApp, url: string): Promise<void> {
    const { logger } = this;
    logger.info(
      `gateway paths: ${JSON.stringify(app.gatewayPaths)} — setGlobalPrefix moves routes, not gateways`,
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
    // Long enough for @OnClose to run before the tour moves on.
    await Bun.sleep(20);
  }
}
