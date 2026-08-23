export const REQUEST_ID_HEADER = 'x-request-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An inbound id is honoured so a trace survives across services - but only if it
 * is a UUID, which is what this would have minted. It is a caller-supplied string
 * that ends up in every line the request writes, so a newline, a megabyte, or a
 * deliberate collision with somebody else's trace is replaced by a fresh one
 * rather than trusted. A production template validated it the same way.
 *
 * The length check first: it is what keeps garbage away from the regex, and the
 * common case has no header at all.
 */
const traceId = (inbound: string | null): string =>
  inbound !== null && inbound.length === 36 && UUID.test(inbound)
    ? inbound
    : crypto.randomUUID();

/**
 * Where the id sits between the middleware that minted it and the mapper that has
 * to put it on a failure. Symbol-keyed and on the request itself, the same channel
 * the socket's gateway runtime travels on: it stays out of anything that
 * enumerates the object, and a property write measured 9.5 ns against 29 ns for a
 * `WeakMap` entry, on a path already accounted for in microseconds.
 */
const ID: unique symbol = Symbol.for('dunx.http.requestId');

interface Tagged {
  [ID]?: string;
}

/**
 * The request id, and the only thing that decides a request has one.
 *
 * The logging middleware sets the header on a response it returns, and a failure
 * is never one - the error mapper builds a fresh `Response` outside the chain. So
 * a guard's 401, a validation 400 and every unmatched 404 went out with no id.
 *
 * Recorded against the request rather than threaded through the mapper, which an
 * app writes its own of. {@link stamp} reads back what {@link assign} recorded, so
 * a path nothing minted an id for is still answered without a header.
 */
export class RequestIds {
  /**
   * Called by `RequestLoggingMiddleware` and by nothing else. Splitting minting
   * from recording would let a second caller invent an id the log line does not
   * carry.
   */
  static assign(req: Request): string {
    const id = traceId(req.headers.get(REQUEST_ID_HEADER));
    (req as Tagged)[ID] = id;
    return id;
  }

  /** The response, with this request's id on it if it was ever given one. */
  static stamp(response: Response, req: Request): Response {
    const id = (req as Tagged)[ID];
    if (id !== undefined) response.headers.set(REQUEST_ID_HEADER, id);
    return response;
  }
}
