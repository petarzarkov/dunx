/**
 * What the dashboard needs from the things it reports on, restated structurally.
 *
 * **This package depends on `@dunx/infra` not at all**, and on `bullmq` not at
 * all - the same choice `@dunx/auth` makes with `DrizzleSource` and `RedisStore`.
 * A dashboard that peer-depended on the queue library would oblige an app with no
 * queues to install it to see its routes, and would put a build-order edge between
 * two packages that never call each other.
 *
 * This list used to be twice as long. `DashboardQueue` and `DashboardJob` restated
 * bullmq's `Queue` and `Job` in enough detail to drive a queue table - signatures
 * shaped to satisfy bullmq's own variance, with a paragraph explaining why. All of
 * it went when bull-board took the queue UI back: the queue object is now passed
 * straight through to `BullMQAdapter`, so there is nothing left to describe.
 *
 * Everything here is satisfied by an object an app already has:
 *
 * | This             | Satisfied by                             |
 * | ---------------- | ---------------------------------------- |
 * | `QueueSource`    | `JobPublisher` from `@dunx/infra/queue`    |
 * | `RedisProbe`     | `RedisConnection` from `@dunx/infra/redis` |
 * | `ConfigValues`   | `ConfigService` from `@dunx/core`          |
 *
 * No adapter, no wrapper - `queues: publisher` in the options is the whole wiring,
 * which is what makes the restatement worth its lines rather than a tax.
 */

/**
 * The validated configuration. `ConfigService` satisfies it as written.
 *
 * Passed in rather than resolved from the container, and that is deliberate twice
 * over. Mechanically, `inject()` only works inside a class the container builds and
 * this middleware is built by a factory. But the better reason is that showing an
 * app's configuration should be something the app **says yes to** - the same
 * instinct behind `reveal` defaulting to revealing nothing.
 */
export interface ConfigValues {
  /**
   * `object`, not `Record<string, unknown>`: an app's `AppConfig` is an interface
   * with no index signature, so the record type would reject the very
   * `ConfigService` this exists to accept. It is enumerated, never read by a key
   * this package knows.
   */
  readonly values: object;
}

/**
 * Where queues come from. `JobPublisher` satisfies it as written.
 *
 * `opened` is what the publisher has opened *so far*, which is deliberately not the
 * same as "every queue this app has" - a queue is a key prefix opened on first use,
 * so a web process that has published to none has opened none. That is why
 * `DashboardOptions.queueNames` exists: a process that consumes a queue it never
 * publishes to has to name it, and the panel says which of the two it is showing.
 */
export interface QueueSource {
  readonly opened: readonly string[];
  /**
   * bullmq's `Queue`, handed to bull-board's `BullMQAdapter` untouched - which is
   * why the return type is `unknown` rather than a restatement. dunx reads nothing
   * off it and calls nothing on it; matching bullmq's own signatures here was a
   * whole file of variance notes existing only to describe a UI dunx no longer
   * renders.
   */
  queue(name: string): unknown;
}

/**
 * Enough Redis to answer "is it up and what is it doing". `RedisConnection`
 * satisfies it, and so does `Bun.RedisClient` with a `send`.
 *
 * `send` rather than a typed `info()`: `INFO` is one command whose reply is a text
 * blob, and adding a method per Redis command to a restatement is how a
 * restatement becomes a client library.
 */
export interface RedisProbe {
  readonly connected: boolean;
  ping(message?: string): Promise<string>;
  send(command: string, args?: readonly string[]): Promise<unknown>;
}

/** The state a probe reports. `unknown` is not `down`; see `StatusDot`. */
export type ProbeState = 'up' | 'down' | 'unknown';

export interface ProbeResult {
  readonly state: ProbeState;
  /** One line for the operator: a latency, a version, a failure message. */
  readonly detail?: string;
}

/**
 * Anything else worth a light on the page - a third-party API, a disk, a leader
 * election. The dashboard awaits it with a timeout and never lets it throw into a
 * response, so a probe that hangs costs one panel rather than the page.
 */
export interface DashboardProbe {
  readonly name: string;
  check(): Promise<ProbeResult> | ProbeResult;
}
