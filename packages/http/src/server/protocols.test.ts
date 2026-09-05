import { afterEach, describe, expect, it } from 'bun:test';
import http2 from 'node:http2';
import { Module } from '@dunx/core';
import { Controller, Get, Post } from '../route/decorators.js';
import type { RouteInput } from '../route/schema.js';
import { Gateway, OnMessage, OnOpen } from '../ws/decorators.js';
import { PubSub } from '../ws/pubsub.js';
import type { Socket } from '../ws/socket.js';
import { HttpFactory, type HttpApp } from './factory.js';

@Controller('/echo')
class EchoController {
  @Get()
  read(): { ok: true } {
    return { ok: true };
  }

  @Post()
  async write({ req }: RouteInput): Promise<{ got: string }> {
    const body = (await req.json()) as { text: string };
    return { got: body.text };
  }
}

@Gateway('/ws')
class BinaryGateway {
  // Subscribed on open, so a `PubSub.publish` has somewhere to land - which is
  // what proves the publish reached the server that owns the sockets.
  @OnOpen()
  opened(socket: Socket): void {
    socket.subscribe('room');
  }

  @OnMessage()
  raw(message: string | Buffer): string {
    // What the frame arrived as, which is exactly what `binaryType` selects.
    return typeof message === 'string'
      ? 'string'
      : (message.constructor.name as string);
  }
}

/**
 * One HTTP/2 request over cleartext. `node:http2` opens with the connection
 * preface, which is the "prior knowledge" path Bun serves without TLS - so this
 * asserts the wire protocol rather than an option being stored.
 */
const overHttp2 = (
  origin: string,
  path: string,
  body?: string,
): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const client = http2.connect(origin);
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('HTTP/2 request timed out'));
    }, 4000);
    const fail = (error: Error): void => {
      clearTimeout(timer);
      client.destroy();
      reject(error);
    };
    client.on('error', fail);

    const request = client.request({
      ':path': path,
      ':method': body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    });
    let text = '';
    let status = 0;
    request.setEncoding('utf8');
    request.on('response', (headers) => {
      status = Number(headers[':status']);
    });
    request.on('data', (chunk: string) => {
      text += chunk;
    });
    request.on('error', fail);
    request.on('end', () => {
      clearTimeout(timer);
      client.close();
      resolve({ status, text });
    });
    request.end(body);
  });

const connect = async (url: string, path: string): Promise<WebSocket> => {
  const socket = new WebSocket(new URL(path, url).href.replace(/^http/, 'ws'));
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
  return socket;
};

const roundTrip = async (socket: WebSocket, frame: Uint8Array) => {
  const reply = new Promise<string>((resolve) => {
    socket.addEventListener(
      'message',
      (event: MessageEvent) => resolve(String(event.data)),
      { once: true },
    );
  });
  socket.send(frame);
  return reply;
};

describe('http2 and http1', () => {
  let app: HttpApp | undefined;

  afterEach(async () => {
    await app?.shutdown();
    app = undefined;
  });

  const boot = async (options: {
    http2?: boolean;
    http1?: boolean;
    gateway?: boolean;
    gatewayPort?: number;
  }): Promise<string> => {
    @Module({
      providers: options.gateway === true ? [BinaryGateway] : [],
      controllers: [EchoController],
    })
    class AppModule {}

    const { gateway: _gateway, ...serve } = options;
    app = await HttpFactory.create(AppModule, {
      ...serve,
      bootLogging: false,
      requestLogging: false,
    });
    return app.listen(0);
  };

  it('serves the same routes over HTTP/2 and HTTP/1.1 on one port', async () => {
    const url = await boot({ http2: true });
    const origin = new URL(url).origin;

    const get = await overHttp2(origin, '/echo');
    expect(get.status).toBe(200);
    expect(JSON.parse(get.text)).toEqual({ ok: true });

    // A body streams over h2 the same way, so the route's own parsing runs.
    const post = await overHttp2(
      origin,
      '/echo',
      JSON.stringify({ text: 'hi' }),
    );
    // 201, which is what a POST returns here - so the h2 request went through
    // the route rather than a generic handler.
    expect(post.status).toBe(201);
    expect(JSON.parse(post.text)).toEqual({ got: 'hi' });

    const overHttp1 = await fetch(`${origin}/echo`);
    expect(overHttp1.status).toBe(200);
    expect(await overHttp1.json()).toEqual({ ok: true });
  });

  it('answers an unmatched path over HTTP/2 through the fetch fallback', async () => {
    const url = await boot({ http2: true });
    const miss = await overHttp2(new URL(url).origin, '/nothing-here');

    expect(miss.status).toBe(404);
    expect(JSON.parse(miss.text)).toMatchObject({ error: 'NOT_FOUND' });
  });

  it('leaves HTTP/2 off by default', async () => {
    const url = await boot({});
    expect(overHttp2(new URL(url).origin, '/echo')).rejects.toThrow();
  });

  it('keeps gateways working alongside HTTP/2', async () => {
    const url = await boot({ http2: true, gateway: true });
    const socket = await connect(url, '/ws');

    expect(await roundTrip(socket, new Uint8Array([1, 2]))).toBe('Buffer');
    socket.close();
  });

  it('refuses HTTP/1.x when http1 is false', async () => {
    const url = await boot({ http2: true, http1: false });
    const origin = new URL(url).origin;

    // Still fine over h2 - it is only HTTP/1.x that is turned away.
    expect((await overHttp2(origin, '/echo')).status).toBe(200);
    expect((await fetch(`${origin}/echo`)).status).toBe(505);
  });

  it('refuses to boot when http1: false would strand a gateway', async () => {
    // Not a warning: the upgrade never reaches dunx, so the app would look
    // healthy while nothing could connect to it.
    const booting = boot({ http2: true, http1: false, gateway: true });

    expect(booting).rejects.toThrow(/nothing could ever connect to \/ws/);
    expect(booting).rejects.toThrow(/Set gatewayPort/);
  });

  it('boots with http1: false and no gateway', async () => {
    const url = await boot({ http2: true, http1: false });
    expect((await overHttp2(new URL(url).origin, '/echo')).status).toBe(200);
  });

  it('boots with http1: false once gatewayPort takes the upgrades', async () => {
    const url = await boot({
      http2: true,
      http1: false,
      gateway: true,
      gatewayPort: 0,
    });
    expect((await overHttp2(new URL(url).origin, '/echo')).status).toBe(200);
    // The routes port refuses HTTP/1.x, which is what http1: false asked for.
    expect((await fetch(`${new URL(url).origin}/echo`)).status).toBe(505);
  });
});

describe('gatewayPort', () => {
  let app: HttpApp | undefined;

  afterEach(async () => {
    await app?.shutdown();
    app = undefined;
  });

  const boot = async (options: {
    http2?: boolean;
    http1?: boolean;
  }): Promise<HttpApp> => {
    @Module({ providers: [BinaryGateway], controllers: [EchoController] })
    class AppModule {}

    app = await HttpFactory.create(AppModule, {
      ...options,
      gatewayPort: 0,
      bootLogging: false,
      requestLogging: false,
    });
    await app.listen(0);
    return app;
  };

  it('serves the gateway on its own port, and not on the routes port', async () => {
    const booted = await boot({});
    expect(booted.gatewayUrl).toBeString();

    const socket = await connect(booted.gatewayUrl as string, '/ws');
    expect(await roundTrip(socket, new Uint8Array([9]))).toBe('Buffer');
    socket.close();
  });

  it('answers a plain HTTP request on the gateway port with 404', async () => {
    const booted = await boot({});
    const response = await fetch(new URL('/echo', booted.gatewayUrl as string));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'NOT_FOUND' });
  });

  it('carries a PubSub publish, since the sockets live on the second server', async () => {
    const booted = await boot({});
    const [a, b] = await Promise.all([
      connect(booted.gatewayUrl as string, '/ws'),
      connect(booted.gatewayUrl as string, '/ws'),
    ]);
    const seen = new Promise<string>((resolve) => {
      b.addEventListener(
        'message',
        (event: MessageEvent) => resolve(String(event.data)),
        { once: true },
      );
    });

    // Both sockets subscribed on open. Publishing on the routes server would
    // fan out to nothing, since the sockets are not on it.
    booted.get(PubSub).publish('room', 'broadcast');
    a.close();
    expect(
      await Promise.race([seen, Bun.sleep(500).then(() => 'TIMEOUT')]),
    ).toBe('broadcast');
    b.close();
  });

  it('leaves gatewayUrl undefined when the ports are not split', async () => {
    @Module({ providers: [BinaryGateway] })
    class AppModule {}
    app = await HttpFactory.create(AppModule, {
      bootLogging: false,
      requestLogging: false,
    });
    await app.listen(0);

    expect(app.gatewayUrl).toBeUndefined();
  });
});

describe('websocket binaryType', () => {
  let app: HttpApp | undefined;

  afterEach(async () => {
    await app?.shutdown();
    app = undefined;
  });

  const boot = async (
    binaryType?: 'nodebuffer' | 'arraybuffer' | 'uint8array' | 'blob',
  ): Promise<string> => {
    @Module({ providers: [BinaryGateway] })
    class AppModule {}

    app = await HttpFactory.create(AppModule, {
      bootLogging: false,
      requestLogging: false,
      ...(binaryType === undefined ? {} : { websocket: { binaryType } }),
    });
    return app.listen(0);
  };

  it('delivers a Buffer by default', async () => {
    const socket = await connect(await boot(), '/ws');
    expect(await roundTrip(socket, new Uint8Array([1]))).toBe('Buffer');
    socket.close();
  });

  it.each([
    ['arraybuffer', 'ArrayBuffer'],
    ['uint8array', 'Uint8Array'],
    ['blob', 'Blob'],
    ['nodebuffer', 'Buffer'],
  ] as const)('delivers %s frames as %s', async (binaryType, expected) => {
    const socket = await connect(await boot(binaryType), '/ws');
    expect(await roundTrip(socket, new Uint8Array([1, 2, 3]))).toBe(expected);
    socket.close();
  });

  it('leaves a text frame a string whatever binaryType says', async () => {
    const url = await boot('blob');
    const socket = await connect(url, '/ws');
    const reply = new Promise<string>((resolve) => {
      socket.addEventListener(
        'message',
        (event: MessageEvent) => resolve(String(event.data)),
        { once: true },
      );
    });
    socket.send('plain text');
    expect(await reply).toBe('string');
    socket.close();
  });
});
