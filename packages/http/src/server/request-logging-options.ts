export interface RequestLoggingOptions {
  /** Bodies past this many characters are logged as a size. Default 2048. `0` omits them. */
  readonly maxBodyLength?: number;
  /**
   * Log the request body. Default `false`, and the cost depends on whether the
   * route declares a `body` schema: +1.9 us when it does, +28.8 us when it does
   * not, because the logger has to `req.clone()` an unread network stream.
   *
   * It is the field most likely to contain a password.
   */
  readonly requestBody?: boolean;
  /** Log the response body. Default `false`, +2.6 us. A response is already a
   * materialised string by the time this clones it. */
  readonly responseBody?: boolean;
  /**
   * Paths to skip entirely: no entry, no trace, no `traceresponse`, and no
   * `AsyncLocalStorage` scope, so anything the handler logs is uncorrelated.
   * `correlateIgnored` buys the correlation back.
   */
  readonly ignore?: readonly string[];
  /**
   * Path prefixes to skip, for a whole mount rather than one path. `ignore` is an
   * exact-match `Set`; this is a loop, so keep the list short. Scanned only when
   * non-empty.
   *
   * ```ts
   * requestLogging: { ignorePrefix: ['/_dunx'] }
   * ```
   */
  readonly ignorePrefix?: readonly string[];
  /**
   * Keep the trace and the async scope on an `ignore`d path. Default `false`.
   * The path still writes no entry; it gets a `traceresponse` and everything the
   * handler logs carries the trace. Costs ~2.2 us of the ~5.4 us the default path
   * spends.
   */
  readonly correlateIgnored?: boolean;
  /**
   * Wrap every request in an `AsyncLocalStorage` scope. Default `true`, +0.91 us.
   * It is what lets a service four frames down log `traceId` without being
   * handed a request. `correlate: false` skips it; this middleware's own entry is
   * unchanged, but every other line the request writes loses its trace.
   */
  readonly correlate?: boolean;
  /**
   * Put `traceresponse` on the response. Default `true`, and ~500 ns of the 4.7 us
   * the path costs, which is the largest thing here that can go without losing a
   * field from a line.
   *
   * `false` keeps the trace on this middleware's own lines, in the async scope and
   * on the metrics exemplar, and withholds the header from every response
   * including a failure's: the error mapper stamps from what `TraceContext.adopt`
   * marked, and this stops it marking.
   */
  readonly traceResponse?: boolean;
  /**
   * Adopt W3C Trace Context, putting `traceId`, `spanId`, `parentSpanId` and
   * `traceFlags` on every line the request writes and `traceresponse` on its
   * response. Default `true`, at 49.2 ns to mint both ids plus one header read.
   * `@dunx/http/client` sends the adopted trace upstream.
   *
   * `false` removes it, and a request then carries no correlation id at all.
   */
  readonly trace?: boolean;
}
