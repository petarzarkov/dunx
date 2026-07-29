import type { BunRequest } from 'bun';
import { describe, expect, it } from 'bun:test';
import { inject, Module } from '@dunx/core';
import { Controller, Get } from '../route/decorators.js';
import { HttpFactory } from '../server/factory.js';
import { Gateway, OnMessage, OnOpen, OnUpgrade } from './decorators.js';
import { PubSub } from './pubsub.js';
import type { Socket } from './socket.js';

/** Open a real socket, or fail rather than hang. */
const open = async (base: string, path: string): Promise<WebSocket> => {
  const socket = new WebSocket(new URL(path, base).href.replace(/^http/, 'ws'));
  await deadline(
    new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('refused')), {
        once: true,
      });
    }),
    'the socket to open',
  );
  return socket;
};

const frame = (socket: WebSocket): Promise<string> =>
  deadline(
    new Promise<string>((resolve) => {
      socket.addEventListener(
        'message',
        (event: MessageEvent) => resolve(String(event.data)),
        { once: true },
      );
    }),
    'a frame',
  );

/** Every await on the network is bounded, so a stall fails instead of hanging. */
const deadline = <T>(
  promise: Promise<T>,
  what: string,
  ms = 2000,
): Promise<T> => {
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms),
  );
  return Promise.race([promise, timer]);
};

const rejectionMessage = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error))
    throw new Error('expected the promise to reject with an Error');
  return error.message;
};

@Controller('notes')
class NotesController {
  @Get('/')
  list(): string[] {
    return ['first'];
  }
}

class Bell {
  readonly #pubsub = inject(PubSub);

  ring(topic: string): number {
    return this.#pubsub.publishEvent(topic, 'rang', { at: 'now' });
  }
}

@Gateway('/live')
class LiveGateway {
  @OnOpen()
  opened(socket: Socket): void {
    socket.subscribe('news');
    socket.send('ready');
  }

  @OnMessage('ping')
  ping(): string {
    return 'pong';
  }
}

// A pattern, which only works because the upgrade goes through Bun's own router.
@Gateway('/room/:room')
class RoomGateway {
  @OnUpgrade()
  entering(req: BunRequest<'/room/:room'>): { room: string } {
    return { room: req.params.room };
  }

  @OnMessage('where')
  where(_payload: unknown, socket: Socket): unknown {
    return socket.data.context;
  }
}

@Module({ controllers: [NotesController], providers: [Bell, LiveGateway] })
class AppModule {}

describe('one Bun.serve for both', () => {
  it('answers an HTTP route and upgrades a gateway on the same server', async () => {
    const app = await HttpFactory.create(AppModule);
    const url = await app.listen(0);

    try {
      const listed = await fetch(new URL('/notes', url));
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual(['first']);

      const socket = await open(url, '/live');
      expect(await frame(socket)).toBe('ready');
      socket.send(JSON.stringify({ event: 'ping' }));
      expect(JSON.parse(await frame(socket))).toEqual({
        event: 'ping',
        data: 'pong',
      });
      socket.close();
    } finally {
      await app.shutdown();
    }
  });

  it('publishes to a topic from an injected service, with no fetch handler anywhere', async () => {
    const app = await HttpFactory.create(AppModule);
    const url = await app.listen(0);

    try {
      const socket = await open(url, '/live');
      expect(await frame(socket)).toBe('ready');

      expect(app.get(PubSub).subscriberCount('news')).toBe(1);
      expect(app.get(Bell).ring('news')).toBeGreaterThan(0);
      expect(JSON.parse(await frame(socket))).toEqual({
        event: 'rang',
        data: { at: 'now' },
      });
      socket.close();
    } finally {
      await app.shutdown();
    }
  });

  it("matches a gateway path pattern and hands @OnUpgrade the request's params", async () => {
    @Module({ providers: [RoomGateway] })
    class RoomModule {}

    const app = await HttpFactory.create(RoomModule);
    const url = await app.listen(0);

    try {
      const socket = await open(url, '/room/general');
      socket.send(JSON.stringify({ event: 'where' }));
      expect(JSON.parse(await frame(socket))).toEqual({
        event: 'where',
        data: { room: 'general' },
      });
      socket.close();
    } finally {
      await app.shutdown();
    }
  });

  // The gateway is mounted as a GET, so the miss is Bun's, in Zig.
  it('answers a non-GET request on a gateway path with the native 404', async () => {
    const app = await HttpFactory.create(AppModule);
    const url = await app.listen(0);

    try {
      const posted = await fetch(new URL('/live', url), { method: 'POST' });
      expect(posted.status).toBe(404);
      const got = await fetch(new URL('/live', url));
      expect(got.status).toBe(426);
    } finally {
      await app.shutdown();
    }
  });

  it('leaves gateway paths alone when a global prefix moves the routes', async () => {
    const app = await HttpFactory.create(AppModule);
    app.setGlobalPrefix('api');
    const url = await app.listen(0);

    try {
      expect((await fetch(new URL('/api/notes', url))).status).toBe(200);
      expect((await fetch(new URL('/notes', url))).status).toBe(404);
      expect(app.gatewayPaths).toEqual(['/live']);
      const socket = await open(url, '/live');
      expect(await frame(socket)).toBe('ready');
      socket.close();
    } finally {
      await app.shutdown();
    }
  });

  it('reports a gateway and a route claiming one path, naming both', async () => {
    @Controller('/live')
    class LiveController {
      @Get('/')
      list(): string {
        return 'clash';
      }
    }

    @Module({ controllers: [LiveController], providers: [LiveGateway] })
    class ClashModule {}

    const app = await HttpFactory.create(ClashModule);
    expect(await rejectionMessage(app.listen(0))).toContain(
      'Gateway path collision: /live is served by a gateway and by ' +
        'LiveController.list()',
    );
    await app.shutdown();
  });

  it('serves an app with no gateways at all, and reports none', async () => {
    @Module({ controllers: [NotesController] })
    class HttpOnlyModule {}

    const app = await HttpFactory.create(HttpOnlyModule);
    const url = await app.listen(0);

    try {
      expect(app.gatewayPaths).toEqual([]);
      expect((await fetch(new URL('/notes', url))).status).toBe(200);
    } finally {
      // Graceful, since nothing can be holding a socket open.
      await deadline(app.shutdown(), 'the HTTP-only app to stop');
    }
  });

  // A graceful Bun stop waits for open connections and a WebSocket never closes on
  // its own, so an app with gateways has to force it. Measured: without the force
  // this call never resolves.
  it('shuts down without hanging while a socket is still open', async () => {
    const app = await HttpFactory.create(AppModule);
    const url = await app.listen(0);
    const socket = await open(url, '/live');
    expect(await frame(socket)).toBe('ready');

    const closed = new Promise<number>((resolve) => {
      socket.addEventListener('close', (event) => resolve(event.code), {
        once: true,
      });
    });

    await deadline(app.shutdown(), 'shutdown with a live socket', 1500);
    expect(await deadline(closed, 'the client to see the close', 1500)).toBe(
      1006,
    );
    expect(await rejectionMessage(fetch(new URL('/notes', url)))).toBeTruthy();
  });
});
