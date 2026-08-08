import type { ModuleNode, ProviderNode } from '@dunx/core';
import type { GatewayNode, RouteNode } from '@dunx/http';
import type { ProbeState } from '../contracts.js';

/**
 * Everything the page reads, declared once.
 *
 * `internal/dashboard-ui` imports these by relative path from this file, exactly
 * as `internal/openapi-ui` imports `PageModel` from `@dunx/openapi`'s source - so
 * the wire format has one declaration and the frontend cannot drift from the
 * handler that fills it. The node types are re-exported rather than restated for
 * the same reason: they are `@dunx/core`'s and `@dunx/http`'s, and a copy shaped
 * for the browser would be a second thing to keep in step.
 */
export type { GatewayNode, ModuleNode, ProbeState, ProviderNode, RouteNode };

/** Split by lifetime, which is also the split by endpoint. */
export interface Meta {
  readonly title: string;
  /** The mount, so the bundle can build its own URLs without guessing. */
  readonly basePath: string;
  /** Where `@dunx/openapi` serves its explorer, if the app said. */
  readonly openApiPath: string | undefined;
  /** 0 disables polling. */
  readonly pollMs: number;
  /**
   * Where bull-board is mounted, always `{basePath}/queues`. Carried rather than
   * derived so the page never builds a URL the server did not agree to.
   */
  readonly queuesPath: string;
}

export interface ConfigEntry {
  readonly key: string;
  /** `typeof`, or `array`/`null`, so a shape is visible without the value. */
  readonly type: string;
  /**
   * Present only when the app's `reveal` predicate said so. Absent means
   * redacted - there is no sentinel string, because a sentinel is indistinguishable
   * from a value that happens to be `'***'`.
   */
  readonly value?: unknown;
}

/**
 * The half that cannot change while the process runs. One request, cached by the
 * page for its lifetime.
 */
export interface Snapshot {
  readonly meta: Meta;
  readonly routes: readonly RouteNode[];
  readonly gateways: readonly GatewayNode[];
  readonly modules: readonly ModuleNode[];
  readonly providers: readonly ProviderNode[];
  /**
   * Absent when no `ConfigService` is bound, which is a different fact from an
   * empty config and is shown as one.
   */
  readonly config: readonly ConfigEntry[] | undefined;
}

export interface ProbeReport {
  readonly name: string;
  readonly state: ProbeState;
  readonly detail?: string;
  /** How long the probe took, so a slow dependency is visible before it fails. */
  readonly ms: number;
}

export interface MemoryReport {
  readonly rss: number;
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly external: number;
}

/** The half that changes. Polled. */
export interface RuntimeReport {
  readonly pid: number;
  readonly uptimeMs: number;
  readonly bun: string;
  readonly platform: string;
  readonly arch: string;
  readonly memory: MemoryReport;
  readonly probes: readonly ProbeReport[];
  /** Server clock, so the page can show ages rather than raw timestamps. */
  readonly now: number;
}

export interface RedisReport {
  readonly configured: true;
  readonly connected: boolean;
  readonly pingMs: number | undefined;
  /**
   * A curated handful from `INFO`: version, mode, uptime, connected clients, used
   * memory, keyspace hits and misses. Not the whole blob - that is 200 lines and it
   * is one `redis-cli INFO` away for anyone who wants it.
   */
  readonly info: Readonly<Record<string, string>>;
  readonly error?: string;
}

/** No `redis` handle was passed, which is different from a broker being down. */
export interface RedisAbsent {
  readonly configured: false;
}

/**
 * What the queues endpoint answers: **names, and nothing else.**
 *
 * Everything *about* a queue - counts, jobs, retries, flows, metrics - is
 * bull-board's, mounted at `{path}/queues`. dunx renders no queue UI, so this
 * exists only so the page knows whether to offer the link and what to say when
 * there is nothing behind it.
 */
export interface QueuesReport {
  readonly queues: readonly string[];
  /** Why there is no board: no source, no queues opened, or bull-board absent. */
  readonly unavailable?: string;
}
