import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { inject, Module } from '@dunx/core';
import { HttpFactory, type HttpApp } from '../server/factory.js';
import {
  Gateway,
  OnClose,
  OnMessage,
  OnOpen,
  OnUpgrade,
} from './decorators.js';
import { PubSub } from './pubsub.js';
import type { Socket } from './socket.js';

interface Client {
  readonly socket: WebSocket;
  next(ms?: number): Promise<string>;
  close(code?: number, reason?: string): void;
}

/** A real client against a real server: no fake socket anywhere in this file. */
const connect = async (base: string, path: string): Promise<Client> => {
  const socket = new WebSocket(new URL(path, base).href.replace(/^http/, 'ws'));
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
    socket.addEventListener(
      'error',
      () => reject(new Error('connect failed')),
      {
        once: true,
      },
    );
  });

  return {
    socket,
    next: (ms = 2000) =>
      new Promise<string>((resolve, reject) => {
        const queued = frames.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for a frame')),
          ms,
        );
        waiting.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      }),
    close: (code, reason) => socket.close(code, reason),
  };
};

/** The rejection message, so a failure reads as one instead of as a timeout. */
const settled = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error)) {
    throw new Error('expected the promise to reject with an Error');
  }
  return error.message;
};

class Rooms {
  readonly joined: string[] = [];

  join(socket: Socket, room: string): number {
    socket.subscribe(room);
    this.joined.push(room);
    return socket.subscriptions.length;
  }
}

const closes: string[] = [];

@Gateway('/chat')
class ChatGateway {
  // inject() rather than a constructor parameter: @dunx/compiler is not preloaded
  // for this package's own tests. examples/ws proves the constructor path.
  readonly #rooms = inject(Rooms);

  @OnOpen()
  opened(socket: Socket): void {
    socket.send('welcome');
  }

  @OnMessage('echo')
  echo(payload: { text: string }): { text: string; length: number } {
    return { text: payload.text, length: payload.text.length };
  }

  @OnMessage('join')
  async join(room: string, socket: Socket): Promise<{ subscriptions: number }> {
    await Bun.sleep(1);
    return { subscriptions: this.#rooms.join(socket, room) };
  }

  @OnMessage('whoami')
  whoami(_payload: unknown, socket: Socket): unknown {
    return socket.data.context;
  }

  @OnMessage('boom')
  boom(): never {
    throw new Error('handler exploded');
  }

  @OnMessage()
  raw(message: string | Buffer): string {
    return `raw:${String(message)}`;
  }

  // Only the code is recorded: Bun delivers an empty `reason` for a client that
  // closes after exchanging frames, whatever the client passed.
  @OnClose()
  closed(socket: Socket, code: number): void {
    closes.push(`${socket.data.path} ${code}`);
  }
}

@Gateway('/admin')
class AdminGateway {
  @OnUpgrade()
  upgrade(req: Request): Response | { user: string } {
    const user = new URL(req.url).searchParams.get('user');
    return user === null
      ? new Response('unauthorized', { status: 401 })
      : { user };
  }

  @OnMessage('whoami')
  whoami(_payload: unknown, socket: Socket): unknown {
    return socket.data.context;
  }
}

describe('a gateway on a real server', () => {
  let app: HttpApp;
  let url: string;
  const errors: unknown[] = [];

  beforeAll(async () => {
    // Gateways are providers, exactly like the services they inject.
    @Module({ providers: [Rooms, ChatGateway, AdminGateway] })
    class AppModule {}

    app = await HttpFactory.create(AppModule, {
      websocket: { idleTimeout: 8, onError: (error) => errors.push(error) },
    });
    url = await app.listen(0);
  });

  afterAll(async () => {
    await app.shutdown();
  });

  it('serves every discovered gateway path', () => {
    expect([...app.gatewayPaths].sort()).toEqual(['/admin', '/chat']);
  });

  it('runs @OnOpen on connect', async () => {
    const client = await connect(url, '/chat');
    expect(await client.next()).toBe('welcome');
    client.close();
  });

  it('routes an envelope to @OnMessage(event) and replies under the same event', async () => {
    const client = await connect(url, '/chat');
    await client.next();

    client.socket.send(JSON.stringify({ event: 'echo', data: { text: 'hi' } }));

    expect(JSON.parse(await client.next())).toEqual({
      event: 'echo',
      data: { text: 'hi', length: 2 },
    });
    client.close();
  });

  it('awaits an async handler before replying', async () => {
    const client = await connect(url, '/chat');
    await client.next();

    client.socket.send(JSON.stringify({ event: 'join', data: 'room-a' }));

    expect(JSON.parse(await client.next())).toEqual({
      event: 'join',
      data: { subscriptions: 1 },
    });
    client.close();
  });

  it('falls back to the raw handler for a frame no event claims', async () => {
    const client = await connect(url, '/chat');
    await client.next();

    client.socket.send('not json');
    expect(await client.next()).toBe('raw:not json');

    client.socket.send(JSON.stringify({ event: 'nope', data: 1 }));
    expect(await client.next()).toBe(
      `raw:${JSON.stringify({ event: 'nope', data: 1 })}`,
    );

    client.close();
  });

  it('sends a throwing handler to onError and keeps the socket open', async () => {
    const client = await connect(url, '/chat');
    await client.next();

    client.socket.send(JSON.stringify({ event: 'boom' }));
    client.socket.send(JSON.stringify({ event: 'echo', data: { text: 'ok' } }));

    expect(JSON.parse(await client.next())).toEqual({
      event: 'echo',
      data: { text: 'ok', length: 2 },
    });
    expect(errors.map(String)).toContain('Error: handler exploded');
    client.close();
  });

  it('broadcasts to a topic through Bun native pub/sub', async () => {
    const one = await connect(url, '/chat');
    const two = await connect(url, '/chat');
    const three = await connect(url, '/chat');
    await Promise.all([one.next(), two.next(), three.next()]);

    one.socket.send(JSON.stringify({ event: 'join', data: 'news' }));
    two.socket.send(JSON.stringify({ event: 'join', data: 'news' }));
    await Promise.all([one.next(), two.next()]);

    const pubsub = app.get(PubSub);
    expect(pubsub.subscriberCount('news')).toBe(2);
    expect(
      pubsub.publishEvent('news', 'headline', 'dunx ships'),
    ).toBeGreaterThan(0);

    const expected = { event: 'headline', data: 'dunx ships' };
    expect(JSON.parse(await one.next())).toEqual(expected);
    expect(JSON.parse(await two.next())).toEqual(expected);
    expect(await settled(three.next(150))).toContain('timed out');

    one.close();
    two.close();
    three.close();
  });

  it('runs @OnClose with the code the client sent', async () => {
    const client = await connect(url, '/chat');
    await client.next();

    closes.length = 0;
    client.close(4001, 'done here');

    await Bun.sleep(50);
    expect(closes).toContain('/chat 4001');
  });

  it('passes what @OnUpgrade returned to the handlers as socket.data.context', async () => {
    const client = await connect(url, '/admin?user=ada');
    client.socket.send(JSON.stringify({ event: 'whoami' }));

    expect(JSON.parse(await client.next())).toEqual({
      event: 'whoami',
      data: { user: 'ada' },
    });
    client.close();
  });

  it('lets @OnUpgrade refuse with its own Response', async () => {
    const refused = await fetch(new URL('/admin', url));
    expect(refused.status).toBe(401);
    expect(await refused.text()).toBe('unauthorized');
  });

  it('answers a plain request on a gateway path with 426', async () => {
    const response = await fetch(new URL('/chat', url));
    expect(response.status).toBe(426);
  });

  // Bun's router owns the miss: there is no fetch handler to fall through to.
  it('answers a path no gateway serves with 404', async () => {
    const response = await fetch(new URL('/nothing', url));
    expect(response.status).toBe(404);
  });
});

describe('HttpFactory with gateways', () => {
  it('resolves a gateway through the container, constructor deps and all', async () => {
    class Greeter {
      greet(name: string): string {
        return `hello ${name}`;
      }
    }

    @Gateway('/greet')
    class GreetGateway {
      readonly #greeter: Greeter;

      constructor(greeter: Greeter) {
        this.#greeter = greeter;
      }

      @OnMessage('greet')
      greet(name: string): string {
        return this.#greeter.greet(name);
      }
    }
    // What @dunx/compiler emits for the constructor above.
    Object.defineProperty(GreetGateway, Symbol.for('dunx.deps'), {
      value: () => [Greeter],
    });

    @Module({ providers: [Greeter, GreetGateway] })
    class AppModule {}

    const app = await HttpFactory.create(AppModule);
    const url = await app.listen(0);

    try {
      const client = await connect(url, '/greet');
      client.socket.send(JSON.stringify({ event: 'greet', data: 'ada' }));
      expect(JSON.parse(await client.next())).toEqual({
        event: 'greet',
        data: 'hello ada',
      });
      client.close();
    } finally {
      await app.shutdown();
    }
  });

  // The whole import graph is walked, so a gateway lives in the feature module it
  // belongs to rather than in a list at the root.
  it('discovers a gateway declared in an imported feature module', async () => {
    @Gateway('/feed')
    class FeedGateway {
      @OnMessage()
      raw(message: string | Buffer): string {
        return `feed:${String(message)}`;
      }
    }

    @Module({ providers: [FeedGateway] })
    class FeedModule {}

    @Module({ imports: [FeedModule] })
    class AppModule {}

    const app = await HttpFactory.create(AppModule);
    const url = await app.listen(0);

    try {
      expect(app.gatewayPaths).toEqual(['/feed']);
      const client = await connect(url, '/feed');
      client.socket.send('now');
      expect(await client.next()).toBe('feed:now');
      client.close();
    } finally {
      await app.shutdown();
    }
  });

  it('reports a gateway with no handlers at boot', async () => {
    @Gateway('/empty')
    class EmptyGateway {}

    @Module({ providers: [EmptyGateway] })
    class AppModule {}

    expect(await settled(HttpFactory.create(AppModule))).toContain(
      'EmptyGateway is registered as a gateway',
    );
  });

  // Without @Gateway the class is an ordinary provider, and its handlers could
  // never receive a frame. Saying so beats a silent no-op.
  it('reports a provider that declares handlers but is not a gateway', async () => {
    class Listener {
      @OnMessage('tick')
      tick(): string {
        return 'tock';
      }
    }

    @Module({ providers: [Listener] })
    class AppModule {}

    expect(await settled(HttpFactory.create(AppModule))).toContain(
      'Listener.tick() is a websocket handler, but Listener is not a gateway',
    );
  });
});

describe('PubSub', () => {
  it('explains itself when nothing is listening yet', () => {
    expect(() => new PubSub().publish('news', 'x')).toThrow(
      'PubSub has no server yet',
    );
    expect(new PubSub().attached).toBe(false);
  });
});
