/**
 * Frozen object plus an indexed-access union, not an `enum`. An enum emits a
 * runtime object that no other syntax can produce, which is why the repo bans it —
 * see CLAUDE.md. This gives the same `HttpStatusCode.NOT_FOUND` ergonomics, a
 * narrower type, and erases cleanly.
 */
export const HttpStatusCode = Object.freeze({
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  MOVED_PERMANENTLY: 301,
  FOUND: 302,
  NOT_MODIFIED: 304,
  TEMPORARY_REDIRECT: 307,
  PERMANENT_REDIRECT: 308,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  CONFLICT: 409,
  GONE: 410,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  URI_TOO_LONG: 414,
  UNSUPPORTED_MEDIA_TYPE: 415,
  IM_A_TEAPOT: 418,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
} as const);

/** The status numbers: `200 | 201 | ...`. */
export type HttpStatusCode =
  (typeof HttpStatusCode)[keyof typeof HttpStatusCode];

/** The names: `'OK' | 'CREATED' | ...`. */
export type HttpStatusName = keyof typeof HttpStatusCode;
