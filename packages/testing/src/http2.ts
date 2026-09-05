import http2 from 'node:http2';
import type { JsonInit, JsonResponse } from './client.js';

/**
 * One HTTP/2 request against a cleartext origin, and the JSON round-trip beside
 * it - the same pair `testClient` gives for HTTP/1.1.
 *
 * It exists because **Bun's `fetch` cannot call an h2c origin**: both
 * `protocol: 'http2'` and `protocol: 'h2'` reject with `HTTP2Unsupported`
 * against any plain-HTTP peer, whatever that peer serves. `node:http2` opens
 * with the connection preface instead, which is the "prior knowledge" path
 * `Bun.serve({ http2: true })` answers.
 *
 * A connection per call, which is what a test wants: the assertion is about the
 * server, and a pooled session would carry state between cases.
 */
export interface Http2Client {
  /** The origin these requests go to. */
  readonly url: string;
  /** Status, headers and the raw body text. */
  request(path?: string, init?: JsonInit): Promise<Http2Response>;
  /** Status, headers and the parsed body, for the common assertion. */
  json<T = unknown>(path?: string, init?: JsonInit): Promise<JsonResponse<T>>;
}

export interface Http2Response {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

/** `:method`, `:path` and the caller's own headers, as one HTTP/2 header block. */
const headerBlock = (
  path: string,
  init: JsonInit,
  body: string | undefined,
): Record<string, string> => {
  const headers = new Headers(init.headers);
  if (body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const block: Record<string, string> = {
    ':path': path,
    ':method': init.method ?? (body === undefined ? 'GET' : 'POST'),
  };
  headers.forEach((value, key) => {
    block[key] = value;
  });
  return block;
};

const send = (
  origin: string,
  path: string,
  init: JsonInit,
  timeoutMs: number,
): Promise<Http2Response> =>
  new Promise((resolve, reject) => {
    const body =
      init.json === undefined
        ? typeof init.body === 'string'
          ? init.body
          : undefined
        : JSON.stringify(init.json);

    const client = http2.connect(origin);
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error(`HTTP/2 ${path} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const fail = (error: Error): void => {
      clearTimeout(timer);
      client.destroy();
      reject(error);
    };
    client.on('error', fail);

    const request = client.request(headerBlock(path, init, body));
    const headers = new Headers();
    let status = 0;
    let text = '';
    request.setEncoding('utf8');
    request.on('response', (received) => {
      status = Number(received[':status']);
      for (const [key, value] of Object.entries(received)) {
        // The pseudo-headers are not headers a `Headers` may carry.
        if (key.startsWith(':') || value === undefined) continue;
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
    });
    request.on('data', (chunk: string) => {
      text += chunk;
    });
    request.on('error', fail);
    request.on('end', () => {
      clearTimeout(timer);
      client.close();
      resolve({ status, headers, text });
    });
    request.end(body);
  });

/**
 * ```ts
 * const server = await createTestServer({ modules: [AppModule], http2: true });
 * const h2 = http2Client(server.url);
 *
 * expect((await h2.json('/users')).status).toBe(200);
 * ```
 */
export const http2Client = (url: string, timeoutMs = 4000): Http2Client => {
  const origin = new URL(url).origin;
  const at = (path: string): string => new URL(path, url).pathname;

  const request = (path = '/', init: JsonInit = {}): Promise<Http2Response> =>
    send(origin, at(path), init, timeoutMs);

  return {
    url: origin,
    request,
    async json<T>(path = '/', init: JsonInit = {}): Promise<JsonResponse<T>> {
      const response = await request(path, init);
      return {
        status: response.status,
        headers: response.headers,
        body: (response.text === ''
          ? undefined
          : JSON.parse(response.text)) as T,
      };
    },
  };
};
