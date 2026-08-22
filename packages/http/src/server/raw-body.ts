import type { BunRequest } from 'bun';

/**
 * The request body text, between the reader that buffered it and the middleware
 * that logs it.
 *
 * **This exists to delete a `Request.clone()`, which is the whole cost of
 * `requestLogging: { requestBody: true }`.** Measured on Bun 1.4 against a
 * validated `POST`, raw `Bun.serve`, 64 connections:
 *
 * | step                                  | us/req |       adds |
 * | ------------------------------------- | -----: | ---------: |
 * | body on the wire, never read          |   8.87 |          - |
 * | `await req.json()`                    |  11.21 |     + 2.34 |
 * | **`+ req.clone()`, clone never read** |  31.58 | **+20.37** |
 * | `+ clone().text()`                    |  29.40 |     - 2.18 |
 * | `+ JSON.parse` of that text           |  29.72 |     + 0.32 |
 * | the body in the entry, serialised     |  11.61 |     + 0.27 |
 *
 * Cloning a request whose body is an unread network stream costs ~8 us before
 * either half is read and ~20 us once one is. The second buffer and the second
 * parse - the parts that look expensive - are 0.32 us together. **So the fix is
 * not to parse once; it is to never clone.** `Response.clone()` does not behave
 * this way, which is why `responseBody: true` costs ~10% against `requestBody`'s
 * ~65%: a response is already a materialised string.
 *
 * **Text, not the parsed value, and that is what makes the output identical.** The
 * logger's own `parse` applies the `maxBodyLength` cap in characters and falls back
 * to the raw string when the body is not JSON - both of which need the text. Handing
 * over the parsed object instead would have meant approximating the cap from
 * `content-length` and losing the body entirely for malformed JSON, which is the
 * request anyone debugging most wants. The second parse this costs is the 0.32 us
 * row above.
 *
 * **Opt-in per request**, because the reader's fast path is `req.json()` and going
 * via `text()` costs +0.38 us. Nobody pays that unless the body is being logged:
 * `want` is what the middleware calls, and with `requestBody: false` - the default -
 * the reader sees an unset flag and behaves exactly as before.
 *
 * Symbol-keyed on the request, the same channel `RequestIds` uses and for the
 * reasons recorded there: it stays out of anything that enumerates the object, and a
 * property write measured 9.5 ns against 29 ns for a `WeakMap` entry.
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
