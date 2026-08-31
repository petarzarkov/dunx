import { Logger, RequestContext } from '@dunx/core';
import { REQUEST_ID_HEADER, type Middleware, type Next } from '@dunx/http';
import type { BunRequest } from 'bun';
import { emitLine, timestamp } from './servers/logging/formats.js';

/**
 * `RequestLoggingMiddleware` truncated one step at a time, for the in-process rig.
 *
 * `servers/logging/dunx.ts` has the same idea behind a socket, where the ladder's
 * floor is around half a microsecond and six of its eleven steps land inside it.
 * Here a step is resolved to about 50 ns, which is what it takes to see the ones
 * that ladder cannot.
 *
 * Each step is decided once against a module constant, so a row pays for the work
 * it declares and not for the check.
 */
export const STEPS = [
  'chain',
  'url',
  'ignored',
  'clock',
  'inbound',
  'uuid',
  'scope',
  'als',
  'request',
  'then',
  'respheader',
  'entry',
  'precomp',
  'precomp-noua',
  'precomp-const',
  'precomp-nowrite',
  'precomp-max',
  'bound',
] as const;
export type Step = (typeof STEPS)[number];

export const isStep = (value: string): value is Step =>
  (STEPS as readonly string[]).includes(value);

/** Module scope so the optimiser cannot drop the work being measured. */
export const sink = { line: '', path: '', count: 0 };

/**
 * Most of the entry never changes for a given route and status. `level`, `pid` and
 * `flow` are constant for the process; `method`, `event` and `context` are
 * constant for the route; `message` is "GET /json 200", so it is constant for the
 * route and status together. Only the timestamp, the request id, the user agent
 * and the elapsed milliseconds vary per request.
 *
 * So the line can be cut into fragments once and roped together per request. A
 * real implementation would hang these off the frozen `RouteContext`, which is
 * built when the route table is; this caches on the same object to price it the
 * same way.
 *
 * `HEAD` carries the timestamp, `MID` the request id, `TAIL` the elapsed time.
 * `noua` drops `request.userAgent`, which removes the one variable field needing
 * an escape check and the longest field on the line.
 */
interface Fragments {
  readonly head: string;
  readonly mid: string;
  readonly tailUa: string;
  readonly tailNoUa: string;
}

const PID = process.pid;
// oxlint-disable-next-line no-control-regex
const DIRTY = /["\\\u0000-\u001f]/;
const quoted = (value: string): string =>
  DIRTY.test(value) ? JSON.stringify(value) : `"${value}"`;

/**
 * The floor. A line of the same length, built nowhere and emitted every request,
 * so the difference to `precomp` is construction and the difference to
 * `precomp-nowrite` is the batching and the write. Nothing that still writes one
 * line per request can beat this row.
 */
const CONSTANT_LINE =
  `{"level":"info","timestamp":"2026-08-31T12:00:00.000Z","pid":12345,` +
  `"message":"GET /json 200","requestId":"3f2a91c4-7b5e-4d18-9a06-2c8e5f1b7d43",` +
  `"method":"GET","event":"/json","flow":"http","context":"BenchController.json",` +
  `"request":{"userAgent":"oha/1.15.0"},"statusCode":200,"elapsedMs":1}`;

const fragmentCache = new Map<string, Fragments>();

const fragmentsFor = (
  method: string,
  path: string,
  context: string,
  status: number,
): Fragments => {
  const key = `${method} ${path} ${status}`;
  const found = fragmentCache.get(key);
  if (found !== undefined) return found;
  const built: Fragments = {
    head: `{"level":"info","timestamp":"`,
    mid:
      `","pid":${PID},"message":"${method} ${path} ${status}",` +
      `"requestId":"`,
    tailUa:
      `","method":"${method}","event":"${path}","flow":"http",` +
      `"context":"${context}","request":{"userAgent":`,
    tailNoUa:
      `","method":"${method}","event":"${path}","flow":"http",` +
      `"context":"${context}","statusCode":${status},"elapsedMs":`,
  };
  fragmentCache.set(key, built);
  return built;
};

/**
 * What a `logger.bind(shape)` writer could reach, and no further.
 *
 * A bound writer cannot hand transports a pre-serialised line: `@arkv/logger`'s
 * `Transport.write(entry, level)` gives each transport the entry and lets it
 * format for itself, which is what lets a console be coloured while a file stays
 * plain JSON. So it builds the **entry object** directly, in its final shape, and
 * the transport still serialises it.
 *
 * Against the shipped path that removes the caller's fields object, the
 * `getContext()` copy and the merge, and keeps `JSON.stringify`. Against
 * `precomp` it keeps the stringify that fragments avoid. The gap between the two
 * is what the transport contract costs.
 */
const boundEntry = (
  stamp: string,
  message: string,
  requestId: string,
  method: string,
  event: string,
  context: string,
  userAgent: string | null,
  statusCode: number,
  elapsedMs: number,
): Record<string, unknown> => ({
  level: 'info',
  timestamp: stamp,
  pid: PID,
  message,
  requestId,
  method,
  event,
  flow: 'http',
  context,
  request: { userAgent },
  statusCode,
  elapsedMs,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Everything given up at once, to bound what is reachable: no
 * `AsyncLocalStorage` scope, so nothing else the request logs carries its id; no
 * inbound `x-request-id` honoured and a counter instead of a UUID, so an id is
 * unique to this process and no further; no `user-agent`; no `x-request-id` on the
 * response; and a five-field line rather than twelve.
 *
 * Not a proposal. The number it produces is the answer to how far this can go
 * while still writing one line per request.
 */
let counter = 0;
const MAX_HEAD = `{"level":"info","timestamp":"`;
const maxCache = new Map<string, string>();
const maxMid = (method: string, path: string, status: number): string => {
  const key = `${method} ${path} ${status}`;
  const found = maxCache.get(key);
  if (found !== undefined) return found;
  const built = `","message":"${method} ${path} ${status}","requestId":"`;
  maxCache.set(key, built);
  return built;
};

export class StepMiddleware implements Middleware {
  readonly #step: number;
  readonly #ignore: ReadonlySet<string>;
  readonly #ignorePrefix: readonly string[];

  constructor(
    private readonly logger: Logger,
    private readonly context: RequestContext,
    step: Step,
  ) {
    this.#step = STEPS.indexOf(step);
    this.#ignore = new Set<string>();
    this.#ignorePrefix = [];
  }

  #at(step: Step): boolean {
    return this.#step === STEPS.indexOf(step);
  }

  handle(req: BunRequest, ctx: never, next: Next): Promise<Response> {
    if (this.#at('chain')) return next();

    const url = req.url;
    const from = url.indexOf('/', url.indexOf('://') + 3);
    const mark = from === -1 ? -1 : url.indexOf('?', from);
    const path =
      from === -1 ? '/' : mark === -1 ? url.slice(from) : url.slice(from, mark);
    sink.path = path;
    if (this.#at('url')) return next();

    if (this.#ignore.size > 0 && this.#ignore.has(path)) return next();
    if (this.#ignorePrefix.length > 0) {
      if (this.#ignorePrefix.some((prefix) => path.startsWith(prefix))) {
        return next();
      }
    }
    if (this.#at('ignored')) return next();

    const started = Bun.nanoseconds();

    if (this.#at('precomp-max')) {
      const mid = maxMid(
        (ctx as unknown as { method: string }).method,
        path,
        200,
      );
      counter += 1;
      const id = counter;
      return next().then((response) => {
        emitLine(
          MAX_HEAD +
            timestamp() +
            mid +
            id +
            '","elapsedMs":' +
            Math.round((Bun.nanoseconds() - started) / 1e6) +
            '}',
        );
        return response;
      });
    }

    if (this.#at('clock')) {
      sink.count += started === 0 ? 1 : 0;
      return next();
    }

    const inbound = req.headers.get(REQUEST_ID_HEADER);
    if (this.#at('inbound')) {
      sink.line = inbound ?? '';
      return next();
    }

    const requestId =
      inbound !== null && inbound.length === 36 && UUID.test(inbound)
        ? inbound
        : crypto.randomUUID();
    if (this.#at('uuid')) {
      sink.line = requestId;
      return next();
    }

    const scope = {
      requestId,
      method: (ctx as unknown as { method: string }).method,
      event: path,
      flow: 'http',
      context: `${(ctx as unknown as { controller: string }).controller}.${(ctx as unknown as { handler: string }).handler}`,
    };
    if (this.#at('scope')) {
      sink.line = scope.context;
      return next();
    }

    return this.context.runWithContext(scope, () => {
      if (this.#at('als')) return next();

      const request: Record<string, unknown> = {};
      request['userAgent'] = req.headers.get('user-agent');
      if (this.#at('request')) {
        sink.line = String(request['userAgent']);
        return next();
      }

      return next().then((response) => {
        // `then` and `respheader` split what used to be one step. The row below
        // it returns `next()` directly, so a single step was carrying both the
        // promise continuation and the `Headers.set`, which are unrelated costs.
        if (this.#at('then')) return response;

        response.headers.set(REQUEST_ID_HEADER, requestId);
        if (this.#at('respheader')) return response;

        const elapsed = Math.round((Bun.nanoseconds() - started) / 1e6);

        if (this.#at('precomp-const')) {
          emitLine(CONSTANT_LINE);
          return response;
        }

        if (this.#at('precomp-nowrite')) {
          const f = fragmentsFor(
            (ctx as unknown as { method: string }).method,
            path,
            scope.context,
            response.status,
          );
          sink.line =
            f.head +
            timestamp() +
            f.mid +
            requestId +
            f.tailNoUa +
            elapsed +
            '}';
          return response;
        }

        if (this.#at('bound')) {
          emitLine(
            JSON.stringify(
              boundEntry(
                timestamp(),
                `${req.method} ${path} ${response.status}`,
                requestId,
                (ctx as unknown as { method: string }).method,
                path,
                scope.context,
                request['userAgent'] as string | null,
                response.status,
                elapsed,
              ),
            ),
          );
          return response;
        }

        if (this.#at('precomp')) {
          const f = fragmentsFor(
            (ctx as unknown as { method: string }).method,
            path,
            scope.context,
            response.status,
          );
          emitLine(
            f.head +
              timestamp() +
              f.mid +
              requestId +
              f.tailUa +
              quoted(String(request['userAgent'])) +
              `},"statusCode":${response.status},"elapsedMs":${elapsed}}`,
          );
          return response;
        }

        if (this.#at('precomp-noua')) {
          const f = fragmentsFor(
            (ctx as unknown as { method: string }).method,
            path,
            scope.context,
            response.status,
          );
          emitLine(
            f.head +
              timestamp() +
              f.mid +
              requestId +
              f.tailNoUa +
              elapsed +
              '}',
          );
          return response;
        }

        this.logger.info(`${req.method} ${path} ${response.status}`, {
          request,
          statusCode: response.status,
          elapsedMs: elapsed,
        });
        return response;
      });
    });
  }
}
