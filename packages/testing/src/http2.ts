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

/** What `request.end()` takes, once a caller's body has been narrowed to it. */
type SendBody = string | ArrayBufferView;

/**
 * `json` wins, then a string or bytes. Anything else throws rather than being
 * dropped: a `FormData` or a stream needs a boundary or a framing this client
 * does not do, and silently sending nothing turned a POST into a GET.
 */
const toBody = (init: JsonInit): SendBody | undefined => {
  if (init.json !== undefined) return JSON.stringify(init.json);
  const { body } = init;
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || ArrayBuffer.isView(body)) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new TypeError(
    'http2Client takes a string, bytes, or `json` - not ' +
      `${body.constructor.name}. Serialise it first, or use \`testClient\` ` +
      'over HTTP/1.1.',
  );
};

/** `:method`, `:path` and the caller's own headers, as one HTTP/2 header block. */
const headerBlock = (
  path: string,
  init: JsonInit,
  body: SendBody | undefined,
): Record<string, string> => {
  const headers = new Headers(init.headers);
  // Only for `json`: a caller passing raw bytes owns its own content type.
  if (init.json !== undefined && !headers.has('content-type')) {
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
    let body: SendBody | undefined;
    try {
      body = toBody(init);
    } catch (error) {
      reject(error as Error);
      return;
    }

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
  // `pathname` alone would drop the query, so `?limit=1` never reached the route.
  const at = (path: string): string => {
    const target = new URL(path, url);
    return `${target.pathname}${target.search}`;
  };

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
