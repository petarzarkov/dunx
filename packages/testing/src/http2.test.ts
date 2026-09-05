import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Controller, Get, Post, type RouteInput } from '@dunx/http';
import { Module } from '@dunx/core';
import { http2Client, type Http2Client } from './http2.js';
import { createTestServer, type TestServer } from './server.js';

@Controller('/things')
class ThingsController {
  @Get()
  list(): { things: string[] } {
    return { things: ['one', 'two'] };
  }

  @Get('text')
  text(): Response {
    return new Response('plain', { headers: { 'x-shape': 'raw' } });
  }

  @Post()
  async create({ req }: RouteInput): Promise<{ got: unknown }> {
    return { got: await req.json() };
  }
}

@Module({ controllers: [ThingsController] })
class AppModule {}

describe('http2Client', () => {
  let server: TestServer;
  let h2: Http2Client;

  beforeAll(async () => {
    // Bun's `fetch` rejects an h2c origin with HTTP2Unsupported whatever the
    // server offers, which is the whole reason this client exists.
    server = await createTestServer({ modules: [AppModule], http2: true });
    h2 = http2Client(server.url);
  });

  afterAll(async () => {
    await server.close();
  });

  it('parses a JSON body over the h2c preface', async () => {
    const response = await h2.json<{ things: string[] }>('/things');

    expect(response.status).toBe(200);
    expect(response.body.things).toEqual(['one', 'two']);
  });

  it('carries the response headers, without the pseudo-headers', async () => {
    const response = await h2.request('/things/text');

    expect(response.text).toBe('plain');
    expect(response.headers.get('x-shape')).toBe('raw');
    expect([...response.headers.keys()].some((k) => k.startsWith(':'))).toBe(
      false,
    );
  });

  it('sends a JSON body, and sets the content type for it', async () => {
    const response = await h2.json<{ got: { a: number } }>('/things', {
      json: { a: 1 },
    });

    // 201 is what a POST answers here, so the route ran rather than a fallback.
    expect(response.status).toBe(201);
    expect(response.body.got).toEqual({ a: 1 });
  });

  it('answers the same as HTTP/1.1 on the same port', async () => {
    const [overH2, overH1] = await Promise.all([
      h2.json<{ things: string[] }>('/things'),
      server.json<{ things: string[] }>('/things'),
    ]);

    expect(overH2.status).toBe(overH1.status);
    expect(overH2.body).toEqual(overH1.body);
  });

  it('rejects rather than hanging when the origin does not speak h2c', async () => {
    const h1Only = await createTestServer({ modules: [AppModule] });
    try {
      await expect(
        http2Client(h1Only.url).request('/things'),
      ).rejects.toThrow();
    } finally {
      await h1Only.close();
    }
  });
});
