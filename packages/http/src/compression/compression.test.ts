import { describe, expect, it } from 'bun:test';
import type { BunRequest } from 'bun';
import type { RouteContext } from '../server/context.js';
import { Compression } from './compression.js';
import { negotiate } from './negotiate.js';
import {
  CompressionEncoding,
  CompressionOptions,
  isCompressibleType,
} from './options.js';

const ctx = {} as RouteContext;

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Long enough to clear the default 1024-byte threshold and to compress well. */
const body = JSON.stringify({
  items: Array.from({ length: 40 }, (_, id) => ({
    id,
    name: `user-${id}`,
    email: `u${id}@example.com`,
    role: 'member',
  })),
});

const request = (accept?: string): BunRequest =>
  new Request('http://localhost/items', {
    ...(accept !== undefined && { headers: { 'accept-encoding': accept } }),
  }) as BunRequest;

/** `headers` as a plain record, so the spread below is an object spread. */
interface JsonInit {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

const json = (init: JsonInit = {}): Response =>
  new Response(body, {
    ...(init.status === undefined ? {} : { status: init.status }),
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      ...init.headers,
    },
  });

const run = (
  req: BunRequest,
  res: Response,
  options: CompressionOptions = new CompressionOptions(),
): Promise<Response> =>
  new Compression(options).handle(req, ctx, async () => res);

describe('negotiate', () => {
  it('honours the server preference order on a tie', () => {
    const offered = [CompressionEncoding.ZSTD, CompressionEncoding.GZIP];
    expect(negotiate('gzip, zstd', offered)).toBe('zstd');
    expect(negotiate('gzip, zstd', [...offered].reverse())).toBe('gzip');
  });

  it('lets an explicit q-value beat the server order', () => {
    expect(negotiate('zstd;q=0.1, gzip;q=0.9', ['zstd', 'gzip'])).toBe('gzip');
  });

  it('treats q=0 as a refusal', () => {
    expect(negotiate('gzip;q=0', ['gzip'])).toBeUndefined();
    expect(negotiate('gzip;q=0, zstd', ['gzip', 'zstd'])).toBe('zstd');
  });

  it('falls back to the wildcard, and to nothing without one', () => {
    expect(negotiate('*', ['gzip'])).toBe('gzip');
    expect(negotiate('br', ['gzip', 'zstd'])).toBeUndefined();
    expect(negotiate('*;q=0', ['gzip'])).toBeUndefined();
  });

  it('answers nothing when the header is absent', () => {
    expect(negotiate(null, ['gzip'])).toBeUndefined();
  });
});

describe('isCompressibleType', () => {
  it('accepts text, json and the structured suffixes', () => {
    expect(isCompressibleType('text/html; charset=utf-8')).toBe(true);
    expect(isCompressibleType('application/json')).toBe(true);
    expect(isCompressibleType('image/svg+xml')).toBe(true);
    expect(isCompressibleType('application/vnd.api+json')).toBe(true);
  });

  it('refuses already-compressed payloads and an absent type', () => {
    expect(isCompressibleType('image/png')).toBe(false);
    expect(isCompressibleType('video/mp4')).toBe(false);
    expect(isCompressibleType('application/zip')).toBe(false);
    expect(isCompressibleType(null)).toBe(false);
  });
});

describe('Compression', () => {
  it('encodes with the negotiated coding and declares the encoded length', async () => {
    const res = await run(request('gzip, zstd'), json());
    expect(res.headers.get('content-encoding')).toBe('zstd');

    const bytes = await res.arrayBuffer();
    expect(bytes.byteLength).toBeLessThan(Buffer.byteLength(body));
    // The header has to describe the bytes actually sent, or the client truncates.
    expect(res.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(text(Bun.zstdDecompressSync(new Uint8Array(bytes)))).toBe(body);
  });

  it('round-trips gzip when that is all the client takes', async () => {
    const res = await run(request('gzip'), json());
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(text(Bun.gunzipSync(bytes))).toBe(body);
  });

  it('varies on accept-encoding even when it does not encode', async () => {
    const res = await run(request(), json());
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('vary')).toBe('accept-encoding');
  });

  it('appends to an existing vary rather than replacing it', async () => {
    const res = await run(
      request('gzip'),
      json({ headers: { vary: 'origin' } }),
    );
    expect(res.headers.get('vary')).toBe('origin, accept-encoding');
  });

  it('leaves a body under the threshold alone', async () => {
    const small = new Response('{"ok":true}', {
      headers: {
        'content-type': 'application/json',
        'content-length': '11',
      },
    });
    const res = await run(request('gzip, zstd'), small);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toBe('{"ok":true}');
  });

  it('skips a type the filter refuses', async () => {
    const png = new Response(body, {
      headers: {
        'content-type': 'image/png',
        'content-length': String(Buffer.byteLength(body)),
      },
    });
    const res = await run(request('gzip, zstd'), png);
    expect(res.headers.get('content-encoding')).toBeNull();
    // Not a candidate at all, so it is not even varied on.
    expect(res.headers.get('vary')).toBeNull();
  });

  it('does not double-encode a body the handler already encoded', async () => {
    const already = new Response(Bun.gzipSync(Buffer.from(body)), {
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
    });
    const res = await run(request('zstd'), already);
    expect(res.headers.get('content-encoding')).toBe('gzip');
  });

  it('respects cache-control: no-transform', async () => {
    const res = await run(
      request('gzip, zstd'),
      json({ headers: { 'cache-control': 'public, no-transform' } }),
    );
    expect(res.headers.get('content-encoding')).toBeNull();
  });

  it('leaves a 304 alone', async () => {
    const notModified = new Response(null, {
      status: 304,
      headers: { 'content-type': 'application/json' },
    });
    const res = await run(request('gzip, zstd'), notModified);
    expect(res.status).toBe(304);
    expect(res.headers.get('content-encoding')).toBeNull();
  });

  it('weakens a strong etag, because the bytes are no longer those bytes', async () => {
    const res = await run(
      request('gzip'),
      json({ headers: { etag: '"abc"' } }),
    );
    expect(res.headers.get('etag')).toBe('W/"abc"');
  });

  it('keeps an already-weak etag as it is', async () => {
    const res = await run(
      request('gzip'),
      json({ headers: { etag: 'W/"abc"' } }),
    );
    expect(res.headers.get('etag')).toBe('W/"abc"');
  });

  /**
   * A `Response` carries no `content-length` unless the handler set one - probed
   * on Bun 1.4 for a string, a Uint8Array, a Blob, `Response.json()` and
   * `Bun.file()`. So this is the ordinary case, not the exotic one, and the
   * middleware has to read the body to learn its size at all.
   */
  it('buffers a body with no declared length, and then declares one', async () => {
    const stream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    const res = await run(request('gzip'), stream);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(res.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(text(Bun.gunzipSync(bytes))).toBe(body);
  });

  it('applies the threshold to an undeclared length too', async () => {
    const stream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":true}'));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    const res = await run(request('gzip, zstd'), stream);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toBe('{"ok":true}');
  });

  /**
   * Past the buffer limit the body keeps streaming rather than being held whole,
   * which is what lets an SSE feed or a large download survive this middleware.
   * The encoded length is unknowable then, so the header goes.
   */
  it('streams a body past the buffer limit instead of holding it', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
    const total = 24; // 1.5 MiB, over the 1 MiB limit
    let sent = 0;
    const huge = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === total) {
            controller.close();
            return;
          }
          sent += 1;
          controller.enqueue(chunk);
        },
      }),
      { headers: { 'content-type': 'text/plain' } },
    );
    const res = await run(request('gzip'), huge);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('content-length')).toBeNull();

    // Every chunk arrives exactly once - the replayed prefix is not re-sent.
    const decoded = Bun.gunzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(decoded.byteLength).toBe(chunk.byteLength * total);
  });

  it('trusts a declared length over the buffer limit and streams it', async () => {
    const chunk = new TextEncoder().encode('y'.repeat(64 * 1024));
    let sent = 0;
    const huge = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 24) {
            controller.close();
            return;
          }
          sent += 1;
          controller.enqueue(chunk);
        },
      }),
      {
        headers: {
          'content-type': 'text/plain',
          'content-length': String(chunk.byteLength * 24),
        },
      },
    );
    const res = await run(request('gzip'), huge);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('content-length')).toBeNull();
  });

  it('preserves the status and the other headers', async () => {
    const res = await run(
      request('gzip'),
      json({ status: 201, headers: { 'x-request-id': 'abc123' } }),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('x-request-id')).toBe('abc123');
  });
});
