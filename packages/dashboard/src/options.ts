import type { BunRequest } from 'bun';
import type {
  ConfigValues,
  DashboardProbe,
  DbStatsSource,
  QueueSource,
  RedisProbe,
  StatsSource,
} from './contracts.js';

/**
 * Decides whether a request may see the dashboard at all. It receives the raw
 * `Request`: the middleware must be registered ahead of any session guard, so
 * there is nothing upstream to have written a context and this has to ask the
 * auth library itself.
 *
 * A rejected request gets 404, not 403.
 */
export type Authorize = (req: BunRequest) => boolean | Promise<boolean>;

/**
 * Whether a config value may be shown. The default reveals nothing: a deny-list
 * of the usual suspects leaks the first key nobody thought of. The panel shows
 * keys and types, and a value appears only when this says so:
 *
 * ```ts
 * reveal: (key) => key.startsWith('PUBLIC_') || key === 'NODE_ENV'
 * ```
 *
 * There is no reveal affordance on the page; redaction is decided at boot.
 */
export type Reveal = (key: string, value: unknown) => boolean;

export interface DashboardOptionsInit {
  /**
   * Where the page is mounted, `/_dunx` by default. `app.setGlobalPrefix('api')`
   * does not move it: that prefixes discovered routes, and this is a middleware
   * matching a path. Write `path: '/api/_dunx'` to put it beside them.
   */
  readonly path?: string;
  /**
   * No default: leaving it out serves the page to anyone who can reach the port,
   * and logs a warning naming the mount path at boot.
   */
  readonly authorize?: Authorize;
  /** Shown in the header and the `<title>`. @default 'dunx' */
  readonly title?: string;
  /** `JobPublisher` goes here. Absent means the panel reports no queue source. */
  readonly queues?: QueueSource;
  /** Queues beyond the ones the source has opened. A consume-only process never
   * publishes, so its queues would otherwise be invisible. */
  readonly queueNames?: readonly string[];
  /** `RedisConnection` goes here; it drives the Redis panel and one probe. */
  readonly redis?: RedisProbe;
  /** Anything else worth a light: a database, an upstream, a leader lease. */
  readonly probes?: readonly DashboardProbe[];
  /** `RequestMetrics` from `@dunx/http` goes here, and needs `metrics: true` on
   * `HttpFactory.create` to have anything in it. Absent means no stats panel. */
  readonly stats?: StatsSource;
  /** `QueryMetrics` from `@dunx/infra/db` goes here, and needs
   * `DbModule.forRoot(options, { metrics: true })`. */
  readonly dbStats?: DbStatsSource;
  /** `ConfigService` goes here; the panel is absent without it. */
  readonly config?: ConfigValues;
  /** See {@link Reveal}. The default reveals nothing, even with `config` set. */
  readonly reveal?: Reveal;
  /** Where `@dunx/openapi` serves its explorer, so a routes row can link to the
   * operation documenting it. A string rather than a dependency. */
  readonly openApiPath?: string;
  /**
   * How often the live panels re-fetch, in milliseconds. `0` turns polling off
   * and leaves the refresh button. Polling rather than a websocket, which would
   * put the dashboard in the app's own upgrade table.
   *
   * @default 5000
   */
  readonly pollMs?: number;
  /**
   * How long a probe may take before it is reported `unknown`.
   *
   * @default 2000
   */
  readonly probeTimeoutMs?: number;
  /**
   * Whether the queue board may change anything, passed through to bull-board's
   * own `readOnlyMode`. The rest of the dashboard is read-only regardless.
   *
   * @default true
   */
  readonly commands?: boolean;
}

/** A class rather than an interface, so it is a runtime value the transform can
 * record as a constructor parameter type. */
export class DashboardOptions {
  readonly path: string;
  readonly authorize: Authorize | undefined;
  readonly title: string;
  readonly queues: QueueSource | undefined;
  readonly queueNames: readonly string[];
  readonly redis: RedisProbe | undefined;
  readonly probes: readonly DashboardProbe[];
  readonly stats: StatsSource | undefined;
  readonly dbStats: DbStatsSource | undefined;
  readonly config: ConfigValues | undefined;
  readonly reveal: Reveal;
  readonly openApiPath: string | undefined;
  readonly pollMs: number;
  readonly probeTimeoutMs: number;
  readonly commands: boolean;

  constructor(init: DashboardOptionsInit = {}) {
    this.path = normalizeMount(init.path ?? '/_dunx');
    this.authorize = init.authorize;
    this.title = init.title ?? 'dunx';
    this.queues = init.queues;
    this.queueNames = init.queueNames ?? [];
    this.redis = init.redis;
    this.probes = init.probes ?? [];
    this.stats = init.stats;
    this.dbStats = init.dbStats;
    this.config = init.config;
    this.reveal = init.reveal ?? (() => false);
    this.openApiPath = init.openApiPath;
    this.pollMs = init.pollMs ?? 5000;
    this.probeTimeoutMs = init.probeTimeoutMs ?? 2000;
    this.commands = init.commands ?? true;
  }
}

/**
 * A leading slash and no trailing one, so `${path}/api/...` is never `//api`.
 * `/` is rejected: mounting at the root would swallow every unmatched path.
 */
export const normalizeMount = (path: string): string => {
  const trimmed = `/${path.split('/').filter(Boolean).join('/')}`;
  if (trimmed === '/') {
    throw new Error(
      'DashboardOptions.path cannot be "/": the dashboard is a middleware that ' +
        'claims every path under its mount, so mounting it at the root would ' +
        'answer every request in the app. Use "/_dunx" or another prefix.',
    );
  }
  return trimmed;
};
