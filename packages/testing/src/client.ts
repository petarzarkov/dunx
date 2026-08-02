export interface JsonInit extends RequestInit {
  /**
   * Serialized as the request body, with `content-type: application/json` set
   * unless `headers` already carries one. Covers every verb, so there is no
   * `post()`/`put()`/`patch()` triple here. Takes precedence over `body`.
   */
  readonly json?: unknown;
}

export interface JsonResponse<T> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

export interface TestClient {
  /** The server's base URL, as `listen()` returned it. */
  readonly url: string;
  /** The raw `Response` - for bytes, HTML, or asserting on a header. */
  request(path?: string, init?: JsonInit): Promise<Response>;
  /** Status, headers and parsed body in one await, which is the common assertion. */
  json<T = unknown>(path?: string, init?: JsonInit): Promise<JsonResponse<T>>;
}

const target = (base: string, path: string): URL => new URL(path, base);

const withJson = (init: JsonInit): RequestInit => {
  const { json, ...rest } = init;
  if (json === undefined) return rest;

  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return { ...rest, headers, body: JSON.stringify(json) };
};

/**
 * `fetch` against one base URL, plus the JSON round-trip every suite otherwise
 * rewrites. Deliberately not an assertion DSL: it returns values that `expect`
 * already reads well, so failures point at the assertion rather than at a matcher
 * this package would have to define.
 *
 * `createTestServer` returns one of these already bound to the server it started;
 * this is here for an app booted some other way.
 */
export const testClient = (url: string): TestClient => ({
  url,
  request: (path = '', init: JsonInit = {}) =>
    fetch(target(url, path), withJson(init)),
  json: async <T>(path = '', init: JsonInit = {}): Promise<JsonResponse<T>> => {
    const response = await fetch(target(url, path), withJson(init));
    // Read as text first: a route that answered 204, HTML or a plain-text error
    // would otherwise fail with `JSON.parse`'s message and none of the context
    // needed to see why.
    const text = await response.text();
    try {
      return {
        status: response.status,
        headers: response.headers,
        body: JSON.parse(text) as T,
      };
    } catch {
      const body =
        text === ''
          ? 'an empty body'
          : `a ${response.headers.get('content-type') ?? 'typeless'} body:\n\n` +
            text.slice(0, 300);
      throw new Error(
        `${init.method ?? 'GET'} ${target(url, path).pathname} answered ` +
          `${response.status} with ${body}\n\nThat is not JSON - use request() ` +
          'for a response that is not.',
      );
    }
  },
});
