import type { HistogramSnapshot } from '@dunx/core';
// Imported as well as re-exported below: a bare re-export puts nothing in scope.
import type { HttpStatsReport, ProbeResult } from '@dunx/http';
/**
 * What the dashboard needs from the things it reports on, restated structurally
 * so this package depends on `@dunx/infra` and `bullmq` not at all. Each is
 * satisfied by an object an app already has:
 *
 * | This           | Satisfied by                               |
 * | -------------- | ------------------------------------------ |
 * | `QueueSource`  | `JobPublisher` from `@dunx/infra/queue`    |
 * | `RedisProbe`   | `RedisConnection` from `@dunx/infra/redis` |
 * | `ConfigValues` | `ConfigService` from `@dunx/core`          |
 * | `StatsSource`  | `RequestMetrics` from `@dunx/http`         |
 * | `DbStatsSource`| `QueryMetrics` from `@dunx/infra/db`       |
 */

/**
 * The validated configuration. `ConfigService` satisfies it as written. Passed in
 * rather than resolved, so showing an app's configuration is something the app
 * says yes to.
 */
export interface ConfigValues {
  /** `object` rather than `Record<string, unknown>`: an app's `AppConfig` has no
   * index signature, so the record type would reject it. */
  readonly values: object;
}

/**
 * Where queues come from. `JobPublisher` satisfies it as written. `opened` is what
 * the publisher has opened so far, not every queue the app has - which is why
 * `DashboardOptions.queueNames` exists for a consume-only process.
 */
export interface QueueSource {
  readonly opened: readonly string[];
  /** bullmq's `Queue`, handed to `BullMQAdapter` untouched, so the return type is
   * `unknown` rather than a restatement. */
  queue(name: string): unknown;
}

/**
 * Per-route request counts and timings. `RequestMetrics` from `@dunx/http`
 * satisfies it as written, and `HttpStatsReport` is imported rather than
 * restated: this package already peer-depends on `@dunx/http`, so a second copy
 * of `RouteStats` here would be a second thing to keep in step.
 */
export interface StatsSource {
  snapshot(): HttpStatsReport;
}

export type { HistogramSnapshot } from '@dunx/core';
export type { HttpStatsReport, RouteStats } from '@dunx/http';

/**
 * Query counts and timings. `QueryMetrics` from `@dunx/infra/db` satisfies it
 * structurally, and `DbStatsReport` **is** restated here for the reason
 * `QueueSource` is: this package depends on `@dunx/infra` not at all, and a peer
 * on it for one report type would be the dependency the boundary exists to
 * refuse. Narrowing a field silently un-satisfies `QueryMetrics`.
 */
export interface DbStatsSource {
  snapshot(): DbStatsReport;
}

export interface DbQueryStats {
  readonly operation: string;
  readonly count: number;
  readonly errors: number;
  readonly duration: HistogramSnapshot;
  readonly slowest?: string;
}

export interface DbStatsReport {
  readonly operations: readonly DbQueryStats[];
  readonly total: number;
  readonly since: string;
}

/**
 * Enough Redis to answer "is it up and what is it doing". `send` rather than a
 * typed `info()`: a method per command is how a restatement becomes a client.
 */
export interface RedisProbe {
  readonly connected: boolean;
  ping(message?: string): Promise<string>;
  send(command: string, args?: readonly string[]): Promise<unknown>;
}

/**
 * The state a probe reports, and its result. `unknown` is not `down`. Declared in
 * `@dunx/http` and re-exported here, since this package already peer-depends on
 * it. `RedisProbe` below did not move with them: `PingProbe` is a `ping` alone.
 */
export type { ProbeResult, ProbeState } from '@dunx/http';

/**
 * Anything else worth a light on the page. Awaited with a timeout and never let
 * to throw, so a probe that hangs costs one panel rather than the page.
 */
export interface DashboardProbe {
  readonly name: string;
  check(): Promise<ProbeResult> | ProbeResult;
}
