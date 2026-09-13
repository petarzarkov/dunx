/**
 * The state a probe reports.
 *
 * `unknown` is not `down`. A probe that timed out has told you nothing, and the
 * difference decides whether traffic is shed: `unknown` on a critical check fails
 * readiness, on a non-critical one it does not. `@dunx/dashboard` had this rule
 * first and re-exports these two from here.
 */
export type ProbeState = 'up' | 'down' | 'unknown';

export interface ProbeResult {
  readonly state: ProbeState;
  /** One line for the operator: a latency, a version, a failure message. */
  readonly detail?: string;
  /**
   * The same facts as values, for what reads the report but not prose - an alert
   * rule, a panel, a scrape. `500f` meaning five hundred failed jobs is
   * otherwise actionable only by a human. Serialised as it stands, so keep it
   * JSON.
   *
   * ```ts
   * return { state: 'up', detail: `${failed} failed`, data: { failed } };
   * ```
   */
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * One thing worth checking.
 *
 * An abstract class rather than an interface because it is an injection site: the
 * container needs a runtime value to record, and an interface there is a boot
 * error. Subclass it, or hand `HealthOptions` any object with the three members.
 */
export abstract class HealthIndicator {
  abstract readonly name: string;
  /**
   * Whether a failure here should shed traffic. `true` by default.
   *
   * `false` reports without gating readiness, which is what memory and disk want: a
   * disk at 91 percent is worth seeing and is not worth pulling the pod out of
   * rotation for, since no other pod is any emptier.
   */
  readonly critical: boolean = true;
  abstract check(): Promise<ProbeResult> | ProbeResult;
}

/**
 * Enough of a client to answer "is it up". `RedisConnection` from
 * `@dunx/infra/redis` satisfies it as written, and so does a bare
 * `Bun.RedisClient`.
 *
 * Narrower than `@dunx/dashboard`'s `RedisProbe` on purpose, and they are not
 * merged. That one also needs `connected` and `send`, because it renders an `INFO`
 * panel; this needs a round trip and nothing else. Sharing one contract would
 * oblige an app to hand a health check two members it never calls.
 */
export abstract class PingProbe {
  abstract ping(message?: string): Promise<string>;
}

/**
 * A database that can be asked for a round trip. `DbConnection` from
 * `@dunx/infra/db` satisfies it once it grows `ping()`.
 *
 * Separate from {@link PingProbe} because the return types differ: a Redis `PING`
 * answers `PONG` and a database round trip answers nothing worth reading.
 */
export abstract class QueryProbe {
  abstract ping(): Promise<void>;
}

/** Enough of an object store to answer "can I reach it", which `Storage` from
 * `@dunx/infra/files` is on either backend. `exists` and not a read or a write:
 * one `HEAD` against S3, one `stat` locally, and nothing left behind. */
export abstract class StorageProbe {
  abstract exists(key: string): Promise<boolean>;
}
