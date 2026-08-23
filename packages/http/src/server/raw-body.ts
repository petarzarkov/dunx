import type { BunRequest } from 'bun';

/**
 * The request body text, between the reader that buffered it and the middleware
 * that logs it. It exists to delete a `Request.clone()`, which is the whole cost
 * of `requestLogging: { requestBody: true }`: cloning a request whose body is an
 * unread network stream costs ~20 us, while the second buffer and second parse are
 * 0.32 us together. `Response.clone()` does not behave this way, which is why
 * `responseBody` costs ~10% against `requestBody`'s ~65%.
 *
 * Text rather than the parsed value, since the logger's cap is in characters and
 * its fallback for malformed JSON is the raw string. Opt-in per request, because
 * `text()` costs +0.38 us over `req.json()`. Symbol-keyed, like `RequestIds`.
 */
const WANTED: unique symbol = Symbol.for('dunx.http.rawBody.wanted');
const TEXT: unique symbol = Symbol.for('dunx.http.rawBody.text');

interface Tagged {
  [WANTED]?: true;
  [TEXT]?: string;
}

export class RawBody {
  /**
   * Called by `RequestLoggingMiddleware` before the chain runs, when it intends to
   * log this body and the route is going to parse it anyway.
   */
  static want(req: BunRequest): void {
    (req as Tagged)[WANTED] = true;
  }

  /** Whether the body reader should buffer the text on the way past. */
  static wanted(req: BunRequest): boolean {
    return (req as Tagged)[WANTED] === true;
  }

  /**
   * Called by the body reader with the text it buffered, **before** validating it.
   *
   * Before, on purpose, and for two reasons. Validation applies defaults, coerces
   * and strips unknown keys, so the validated object is not what the caller sent.
   * And a body that fails to parse at all still has text - which is the case the
   * clone used to cover and the reason this holds text rather than a value.
   */
  static record(req: BunRequest, text: string): void {
    (req as Tagged)[TEXT] = text;
  }

  /** The buffered text, or `undefined` when nothing read one. */
  static read(req: BunRequest): string | undefined {
    return (req as Tagged)[TEXT];
  }
}
