import { Durations, type HistogramSnapshot } from '@dunx/core';
import type { BunRequest, Server } from 'bun';
import { UNMATCHED } from '../route/metadata.js';
import type { RouteContext } from './context.js';
import { HttpError } from './errors.js';
import type { Middleware, Next } from './middleware.js';
import { HttpStatusCode } from './status.js';

/** Every path Bun matched nothing for, collapsed into one series. */
export const UNMATCHED_ROUTE = '(unmatched)';

export interface RouteStats {
  /** The route pattern, so `/users/1` and `/users/2` share one series. */
  readonly route: string;
  readonly method: string;
  readonly count: number;
  /** Keyed by status code as a string, because that is what JSON gives back. */
  readonly byStatus: Readonly<Record<string, number>>;
  /** Nanoseconds. */
  readonly duration: HistogramSnapshot;
  /**
   * The trace of the slowest request on this route so far, which is the only
   * question a p99 provokes: which request was it, and where are its logs.
   */
  readonly slowestTraceId?: string;
}

export interface HttpStatsReport {
  readonly routes: readonly RouteStats[];
  /** Read off `Bun.serve` at 14.7 ns rather than counted, so dunx counts nothing. */
  readonly inFlight: number;
  readonly pendingWebSockets: number;
  /** When the counters were last reset, or boot. */
  readonly since: string;
}

interface Series {
  readonly route: string;
  readonly method: string;
  count: number;
  readonly byStatus: Record<string, number>;
  readonly duration: Durations;
  slowestNs: number;
  slowestTraceId: string | undefined;
}

const seriesFor = (route: string, method: string): Series => ({
  route,
  method,
  count: 0,
  byStatus: {},
  duration: new Durations(),
  slowestNs: 0,
  slowestTraceId: undefined,
});

/**
 * One series per route, keyed on the frozen `RouteContext` that `buildContext`
 * makes once at boot. That object identity is the label set: a `Map` lookup on it
 * is 8.8 ns, where building `${method} ${path}` and hashing it is 206.6 ns.
 *
 * Series count is bounded by the handler count, because `ctx.path` is the route
 * pattern rather than the request's path.
 *
 * Bound by `HttpFactory`'s global wrapper, like `PubSub` and `ClientAddress`: an
 * unbound class self-binds into whichever scope asks first, so a second consumer
 * would be a boot error.
 *
 * `observe` takes everything as parameters and reads no ambient store, which is
 * what keeps it at 35.2 ns folded into the `.then` request logging already
 * allocates.
 */
export class RequestMetrics {
  readonly #series = new Map<RouteContext, Series>();
  /**
   * Misses, keyed by method rather than by context.
   *
   * `unmatchedContext` builds a **fresh** context per request carrying the
   * concrete pathname, so a 404's log line can name what missed. Keying those by
   * identity neither collapses them nor stays bounded: a scanner walking urls
   * would add a `Map` entry and a histogram per probe, for as long as it ran.
   * The method set is bounded, so this is.
   */
  readonly #unmatched = new Map<string, Series>();
  #since = new Date();
  #server: Server<unknown> | undefined;

  observe(
    ctx: RouteContext,
    status: number,
    durationNs: number,
    traceId?: string,
  ): void {
    // The `Map` lookup first, at 8.8 ns: a matched route hits it from its second
    // request onwards and never pays for the `UNMATCHED` read.
    let series = this.#series.get(ctx);
    if (series === undefined) {
      if (ctx.get(UNMATCHED) === true) {
        series = this.#unmatched.get(ctx.method);
        if (series === undefined) {
          series = seriesFor(UNMATCHED_ROUTE, ctx.method);
          this.#unmatched.set(ctx.method, series);
        }
      } else {
        series = seriesFor(ctx.path, ctx.method);
        this.#series.set(ctx, series);
      }
    }
    series.count += 1;
    const key = String(status);
    series.byStatus[key] = (series.byStatus[key] ?? 0) + 1;
    series.duration.record(durationNs);
    if (durationNs > series.slowestNs) {
      series.slowestNs = durationNs;
      series.slowestTraceId = traceId;
    }
  }

  snapshot(): HttpStatsReport {
    const routes: RouteStats[] = [];
    for (const series of [
      ...this.#series.values(),
      ...this.#unmatched.values(),
    ]) {
      routes.push({
        route: series.route,
        method: series.method,
        count: series.count,
        byStatus: { ...series.byStatus },
        duration: series.duration.snapshot(),
        ...(series.slowestTraceId === undefined
          ? {}
          : { slowestTraceId: series.slowestTraceId }),
      });
    }
    return {
      routes,
      inFlight: this.#server?.pendingRequests ?? 0,
      pendingWebSockets: this.#server?.pendingWebSockets ?? 0,
      since: this.#since.toISOString(),
    };
  }

  /**
   * Drops every series rather than zeroing them, so a route that stopped being
   * called stops being reported. A cumulative histogram over a week has a p99
   * reflecting a deploy three days ago; who calls this is the app's decision.
   */
  reset(): void {
    this.#series.clear();
    this.#unmatched.clear();
    this.#since = new Date();
  }

  /** Internal: `listen()` hands the bound server to the resolved singleton. */
  attach(server: Server<unknown>): void {
    this.#server = server;
  }
}

/**
 * Whether `MetricsMiddleware` is the thing doing the observing.
 *
 * With request logging on - the default - `RequestLoggingMiddleware` observes
 * from the `.then` it already allocates and this middleware would double-count.
 * Exported because `HttpFactory` binds it and `HttpApplication` installs it, and
 * the two disagreeing would mean either no metrics or twice as many.
 */
export const usesMetricsMiddleware = (options: {
  readonly metrics?: boolean;
  readonly requestLogging?: unknown;
}): boolean => options.metrics === true && options.requestLogging === false;

/**
 * Installed by `HttpFactory` only when `requestLogging: false`. With logging on -
 * the default - `RequestLoggingMiddleware` calls `observe` from the `.then` it
 * already allocates, at 35.2 ns against this middleware's 175.9 ns standalone.
 */
export class MetricsMiddleware implements Middleware {
  constructor(private readonly metrics: RequestMetrics) {}

  handle(_req: BunRequest, ctx: RouteContext, next: Next): Promise<Response> {
    const started = Bun.nanoseconds();
    return next().then(
      (response) => {
        this.metrics.observe(ctx, response.status, Bun.nanoseconds() - started);
        return response;
      },
      (error: unknown) => {
        this.metrics.observe(
          ctx,
          error instanceof HttpError
            ? error.status
            : HttpStatusCode.INTERNAL_SERVER_ERROR,
          Bun.nanoseconds() - started,
        );
        throw error;
      },
    );
  }
}
