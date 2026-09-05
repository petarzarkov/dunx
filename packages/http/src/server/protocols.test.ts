import { afterEach, describe, expect, it } from 'bun:test';
import http2 from 'node:http2';
import { Module } from '@dunx/core';
import { Controller, Get, Post } from '../route/decorators.js';
import type { RouteInput } from '../route/schema.js';
import { Gateway, OnMessage } from '../ws/decorators.js';
import { HttpFactory, type HttpApp } from './factory.js';
import { captured } from './request-logging.fixture.test.js';

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

  it('warns at boot when http1: false would strand a gateway', async () => {
    const entries = await captured(async () => {
      await boot({ http2: true, http1: false, gateway: true });
    });

    const warning = entries.find((entry) =>
      String(entry['message']).includes('http1: false'),
    );
    expect(warning).toBeDefined();
    expect(warning?.['level']).toBe('warn');
    expect(String(warning?.['message'])).toContain('/ws');
  });

  it('says nothing when http1: false serves no gateway', async () => {
    const entries = await captured(async () => {
      await boot({ http2: true, http1: false });
    });

    expect(
      entries.filter((entry) =>
        String(entry['message']).includes('http1: false'),
      ),
    ).toEqual([]);
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
