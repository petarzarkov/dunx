import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { AsyncRequestContext, ConsoleLogger } from '@dunx/core';
import { FetchError, FetchTransportError } from './errors.js';
import { HttpClientOptions, type HttpClientOptionsInit } from './options.js';
import { HttpService } from './service.js';

/**
 * A real `Bun.serve` upstream on port 0, not a stubbed `fetch`.
 *
 * A client's whole job is what happens over a socket: a status, a header, a body
 * that is not JSON, a connection that never answers. A monkey-patched `fetch` tests
 * the parts around that and asserts the author's idea of the parts inside it.
 */
interface Json {
  readonly ok: boolean;
  readonly method: string;
}

let server: ReturnType<typeof Bun.serve>;
let base: string;

/** Per-path attempt counters, so a test can assert a call was retried. */
const hits = new Map<string, number>();
const count = (path: string): number => {
  const next = (hits.get(path) ?? 0) + 1;
  hits.set(path, next);
  return next;
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const { pathname } = url;
      const attempt = count(pathname);
      /*
       * Drained for every path, not only /echo. A response sent while the request
       * body is still arriving leaves unread bytes on a keep-alive connection, and
       * the *next* request over it comes back 400 - which is how a streaming test
       * silently broke the FormData test that ran after it.
       */
      const text = await request.text();

      switch (pathname) {
        case '/json':
          return Response.json({ ok: true, method: request.method });
        case '/echo':
          return Response.json({
            body: text,
            contentType: request.headers.get('content-type'),
            accept: request.headers.get('accept'),
            trace: request.headers.get('x-trace'),
            signed: request.headers.get('x-signature'),
          });
        case '/text':
          return new Response('not json at all');
        case '/empty':
          return new Response(null, { status: 204 });
        case '/boom':
          return Response.json(
            { message: 'upstream exploded' },
            { status: 500 },
          );
        case '/bad-request':
          return Response.json({ message: 'nope' }, { status: 400 });
        // Fails twice, then succeeds - so a success proves the retry ran.
        case '/flaky':
          return attempt < 3
            ? new Response('later', { status: 503 })
            : Response.json({ attempt });
        case '/rate-limited':
          return attempt < 2
            ? new Response('slow down', {
                status: 429,
                headers: { 'retry-after': '0' },
              })
            : Response.json({ attempt });
        case '/slow':
          await Bun.sleep(3000);
          return Response.json({ ok: true });
        case '/query':
          return Response.json({ search: url.search, path: pathname });
        case '/sse':
          return new Response(
            'data: one\n\ndata: two\n\ndata: [DONE]\n\ndata: never\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        default:
          return new Response('missing', { status: 404 });
      }
    },
  });
  base = server.url.href;
});

afterAll(async () => {
  await server.stop(true);
});

/**
 * A real logger and a real context, not stubs - `ConsoleLogger` takes the context as
 * its first argument and reads it on every entry, so passing one is the only way the
 * header propagation is being tested rather than mocked. `'fatal'` silences the
 * output without silencing the calls.
 */
const clientFor = (
  init: HttpClientOptionsInit = {},
  context: AsyncRequestContext = new AsyncRequestContext(),
): HttpService =>
  new HttpService(
    new HttpClientOptions({ baseUrl: base, ...init }),
    new ConsoleLogger(context, 'fatal'),
    context,
  );

describe('a successful call', () => {
  it('parses a JSON body and reports the method', async () => {
    const client = clientFor();
    // The response type is named at the call site, as a consumer names it.
    expect(await client.get<Json>('', { path: 'json' })).toEqual({
      ok: true,
      method: 'GET',
    });
  });

  it('returns text when the body is not JSON', async () => {
    expect(await clientFor().get<string>(`${base}text`)).toBe(
      'not json at all',
    );
  });

  it('returns undefined for an empty body', async () => {
    expect(await clientFor().get(`${base}empty`)).toBeUndefined();
  });

  it('serialises a JSON payload and sets the content type', async () => {
    const echoed = (await clientFor().post(`${base}echo`, { a: 1 })) as {
      body: string;
      contentType: string;
      accept: string;
    };
    expect(JSON.parse(echoed.body)).toEqual({ a: 1 });
    expect(echoed.contentType).toBe('application/json');
    expect(echoed.accept).toBe('application/json');
  });

  /**
   * The body path uses plain `JSON.stringify`, not the circular-safe one. The
   * implementation this was ported from used the safe one for both, so a cycle was
   * *sent* as "[Circular]" - a wrong body that reads as a successful call.
   */
  it('throws on a circular payload rather than sending [Circular]', async () => {
    const node: Record<string, unknown> = { name: 'a' };
    node['self'] = node;

    await expect(clientFor().post(`${base}echo`, node)).rejects.toThrow(
      TypeError,
    );
  });

  /**
   * A stream is consumed by the first attempt, so a retry would send an empty body.
   * Retrying is switched off rather than left to fail as "body already used".
   */
  it('does not retry a stream body, which cannot be replayed', async () => {
    let attempts = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk'));
        controller.close();
      },
    });

    await clientFor({
      retry: {
        maxRetries: 3,
        retryDelayMs: 1,
        onAttempt: () => (attempts += 1),
      },
    })
      .post(`${base}boom`, stream)
      .catch(() => undefined);

    expect(attempts).toBe(1);
  });

  /** `fetch` owns the boundary for a FormData, so the client must not touch it. */
  it('passes a FormData through without JSON-encoding it', async () => {
    const form = new FormData();
    form.set('field', 'value');
    const echoed = (await clientFor().post(`${base}echo`, form)) as {
      body: string;
      contentType: string;
    };
    expect(echoed.contentType).toContain('multipart/form-data');
    expect(echoed.body).toContain('field');
  });

  it('builds a url from a base, a path param and query params', async () => {
    const answer = (await clientFor().get('', {
      path: 'query',
      queryParams: { page: 2, tag: 'a b' },
    })) as { search: string };
    expect(answer.search).toContain('page=2');
    expect(answer.search).toContain('tag=a+b');
  });

  /**
   * The form every HTTP client takes once a base url exists. Passing it straight
   * through threw ERR_INVALID_URL from inside `new URL()`, naming neither the call
   * nor the missing base.
   */
  it('takes a relative url against the base', async () => {
    expect(await clientFor().get<Json>('/json')).toEqual({
      ok: true,
      method: 'GET',
    });
    expect(await clientFor().get<Json>('json')).toEqual({
      ok: true,
      method: 'GET',
    });
  });

  it('takes an absolute url, ignoring the base', async () => {
    expect(
      await clientFor({ baseUrl: 'http://127.0.0.1:1' }).get<Json>(
        `${base}json`,
      ),
    ).toEqual({ ok: true, method: 'GET' });
  });

  it('says so when there is neither a base nor an absolute url', async () => {
    const client = new HttpService(
      new HttpClientOptions({}),
      new ConsoleLogger(new AsyncRequestContext(), 'fatal'),
      new AsyncRequestContext(),
    );
    const error = await client
      .get('/nowhere')
      .catch((thrown: unknown) => thrown);
    expect((error as Error).cause).toMatchObject({
      message: expect.stringContaining('set baseUrl'),
    });
  });

  it('interpolates {param} in a path', async () => {
    const answer = await clientFor().get<Json>('', {
      path: '{resource}',
      pathParams: { resource: 'json' },
    });
    expect(answer.ok).toBe(true);
  });
});

describe('headers', () => {
  it('merges client headers under per-call headers', async () => {
    const client = clientFor({ headers: { 'x-trace': 'from-client' } });
    const echoed = (await client.get(`${base}echo`, {
      headers: { 'x-trace': 'from-call' },
    })) as { trace: string };
    expect(echoed.trace).toBe('from-call');
  });

  /** A signature has to cover the body it is actually sent with. */
  it('gives headerFactory the serialised body and the request path', async () => {
    let seen: { requestPath: string; body: string } | undefined;
    const echoed = (await clientFor().post(
      `${base}echo`,
      { a: 1 },
      {
        headerFactory: (params) => {
          seen = { requestPath: params.requestPath, body: params.body };
          return { 'x-signature': `len-${params.body.length}` };
        },
      },
    )) as { signed: string };

    expect(seen?.requestPath).toBe('/echo');
    expect(seen?.body).toBe('{"a":1}');
    expect(echoed.signed).toBe('len-7');
  });
});

describe('failure', () => {
  it('throws a FetchError carrying the status and the parsed body', async () => {
    try {
      await clientFor({ retry: { maxRetries: 0 } }).get(`${base}boom`);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FetchError);
      const fetchError = error as FetchError;
      expect(fetchError.status).toBe(500);
      expect(fetchError.body).toEqual({ message: 'upstream exploded' });
      expect(fetchError.response.method).toBe('GET');
      expect(fetchError.message).toContain('/boom');
    }
  });

  /**
   * The decision recorded in errors.ts: an upstream status must not become this
   * service's status by default, or an upstream 401 tells our own client they are
   * unauthorized.
   */
  it('is not an HttpError, so the error mapper cannot pass the status through', async () => {
    const { HttpError } = await import('../server/errors.js');
    const error = await clientFor({ retry: { maxRetries: 0 } })
      .get(`${base}bad-request`)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FetchError);
    expect(error).not.toBeInstanceOf(HttpError);
  });

  it('wraps a connection failure, naming the call', async () => {
    // Port 1 is privileged and nothing listens: connect fails rather than hangs.
    const client = clientFor({
      baseUrl: 'http://127.0.0.1:1',
      retry: { maxRetries: 0 },
    });
    const error = await client.get().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FetchTransportError);
    expect((error as FetchTransportError).aborted).toBe(false);
    expect((error as Error).message).toContain('127.0.0.1:1');
  });

  it('aborts on the timeout and does not retry an abort', async () => {
    let attempts = 0;
    const error = await clientFor({
      timeoutMs: 150,
      retry: { maxRetries: 3, onAttempt: () => (attempts += 1) },
    })
      .get(`${base}slow`)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FetchTransportError);
    expect((error as FetchTransportError).aborted).toBe(true);
    // The budget for the call is spent; retrying would spend it again.
    expect(attempts).toBe(1);
  });

  it('honours a caller signal alongside the timeout', async () => {
    const controller = new AbortController();
    const inFlight = clientFor({ retry: { maxRetries: 0 } })
      .get(`${base}slow`, { signal: controller.signal })
      .catch((thrown: unknown) => thrown);

    controller.abort();
    expect(await inFlight).toBeInstanceOf(FetchTransportError);
  });
});

describe('retry', () => {
  it('retries a 503 and returns the eventual success', async () => {
    const attemptsSeen: number[] = [];
    const answer = (await clientFor({
      retry: {
        maxRetries: 3,
        retryDelayMs: 1,
        backoff: { jitterMs: 1 },
        onAttempt: (attempt) => attemptsSeen.push(attempt),
      },
    }).get(`${base}flaky`)) as { attempt: number };

    expect(answer.attempt).toBe(3);
    expect(attemptsSeen).toEqual([1, 2, 3]);
  });

  it('does not retry a 400, which would get the same answer', async () => {
    let attempts = 0;
    await clientFor({
      retry: {
        maxRetries: 3,
        retryDelayMs: 1,
        onAttempt: () => (attempts += 1),
      },
    })
      .get(`${base}bad-request`)
      .catch(() => undefined);

    expect(attempts).toBe(1);
  });

  /** The header the reference ignored, which is what made it retry into a limit. */
  it('waits the Retry-After a 429 asked for', async () => {
    const answer = (await clientFor({
      retry: { maxRetries: 2, retryDelayMs: 1, backoff: { jitterMs: 1 } },
    }).get(`${base}rate-limited`)) as { attempt: number };

    expect(answer.attempt).toBe(2);
  });

  it('reports every attempt and the final failure through the callbacks', async () => {
    const errors: boolean[] = [];
    await clientFor({
      retry: {
        maxRetries: 1,
        retryDelayMs: 1,
        backoff: { jitterMs: 1 },
        onError: (_error, _attempt, willRetry) => errors.push(willRetry),
      },
    })
      .get(`${base}boom`)
      .catch(() => undefined);

    // First failure retries, the last one does not.
    expect(errors).toEqual([true, false]);
  });

  it('takes per-call retry options over the client default', async () => {
    let attempts = 0;
    await clientFor({ retry: { maxRetries: 5, retryDelayMs: 1 } })
      .get(`${base}boom`, {
        retry: { maxRetries: 0, onAttempt: () => (attempts += 1) },
      })
      .catch(() => undefined);

    expect(attempts).toBe(1);
  });
});

describe('streamSse', () => {
  it('yields each data payload and stops at the DONE sentinel', async () => {
    const seen: string[] = [];
    for await (const chunk of clientFor().streamSse({
      url: `${base}sse`,
      method: 'GET',
    })) {
      seen.push(chunk);
    }
    // `never` follows `[DONE]` and must not be yielded.
    expect(seen).toEqual(['one', 'two']);
  });

  it('throws a FetchError when the stream never opens', async () => {
    const stream = clientFor().streamSse({ url: `${base}boom`, method: 'GET' });
    await expect(stream.next()).rejects.toBeInstanceOf(FetchError);
  });
});
