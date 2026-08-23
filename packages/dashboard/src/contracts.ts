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

// Imported as well as re-exported: a bare re-export puts nothing in scope.
import type { ProbeResult } from '@dunx/http';

/**
 * Anything else worth a light on the page. Awaited with a timeout and never let
 * to throw, so a probe that hangs costs one panel rather than the page.
 */
export interface DashboardProbe {
  readonly name: string;
  check(): Promise<ProbeResult> | ProbeResult;
}
