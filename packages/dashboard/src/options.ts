import type { BunRequest } from 'bun';
import type {
  ConfigValues,
  DashboardProbe,
  QueueSource,
  RedisProbe,
} from './contracts.js';

/**
 * Decides whether a request may see the dashboard at all.
 *
 * It receives the **raw `Request`**, not an `AuthContext` some earlier middleware
 * wrote, and that is load bearing rather than incidental. The dashboard middleware
 * has to be registered ahead of any session guard - measured in `dunx-template`,
 * where a guard running first answered every dashboard request `401` before
 * `authorize` was reached, which defeats the 404 contract below entirely. Running
 * first means there is nothing upstream to have written a context, so this has to
 * be able to ask the auth library itself.
 *
 * A rejected request gets **404, not 403**. A dashboard that announces itself to
 * an unauthenticated caller has told them where to keep knocking.
 */
export type Authorize = (req: BunRequest) => boolean | Promise<boolean>;

/**
 * Whether a config value may be shown.
 *
 * **The default reveals nothing**, and that is the answer to the open question the
 * design left. `ConfigService` holds whatever the app's `validate` returned, which
 * includes every secret it has; a deny-list of the usual suspects - `SECRET`,
 * `PASSWORD`, `TOKEN` - looks careful and leaks the first key nobody thought of.
 * A deny-list that quietly misses one is worse than no config panel at all.
 *
 * So the panel shows **keys and types** by default, which is most of what it was
 * wanted for ("is FEATURE_X actually set here"), and a value appears only when this
 * predicate says so:
 *
 * ```ts
 * reveal: (key) => key.startsWith('PUBLIC_') || key === 'NODE_ENV'
 * ```
 *
 * There is no "reveal" affordance on the page. Redaction is decided at boot by the
 * app, not per click by whoever reached the page.
 */
export type Reveal = (key: string, value: unknown) => boolean;

export interface DashboardOptionsInit {
  /**
   * Where the page is mounted. `/_dunx` by default - the underscore keeps it
   * clear of an app's own routes, and the name is the framework's rather than
   * `/queues`, because queues are one panel of six.
   *
   * **`app.setGlobalPrefix('api')` does not move it.** That prefixes the routes
   * discovered from controllers, and this is not one of those - it is a middleware
   * matching a path, which is the whole reason the dashboard needs no controllers
   * for a table handed over at runtime. An app with a global prefix that wants the
   * page beside its routes writes `path: '/api/_dunx'` here.
   */
  readonly path?: string;
  /**
   * **There is no default, and leaving it out serves the page to anyone who can
   * reach the port.** That is fine behind a private network and bad everywhere
   * else, so it is stated either way rather than guessed: omitting it logs a
   * warning naming the mount path at boot.
   */
  readonly authorize?: Authorize;
  /** Shown in the header and the `<title>`. @default 'dunx' */
  readonly title?: string;
  /**
   * `JobPublisher` goes here. Absent means the queues panel says this process has
   * no queue source rather than that it has no queues.
   */
  readonly queues?: QueueSource;
  /**
   * Queues to show beyond the ones the source has opened. A process that
   * **consumes** a queue never publishes to it, so the publisher has never opened
   * it and it would otherwise be invisible on the page that exists to show it.
   */
  readonly queueNames?: readonly string[];
  /** `RedisConnection` goes here; it drives the Redis panel and one probe. */
  readonly redis?: RedisProbe;
  /** Anything else worth a light: a database, an upstream, a leader lease. */
  readonly probes?: readonly DashboardProbe[];
  /**
   * `ConfigService` goes here, and the panel is absent without it - showing an
   * app's configuration is something the app says yes to, not something this
   * package reaches into the container for.
   */
  readonly config?: ConfigValues;
  /** See {@link Reveal}. The default reveals nothing, even with `config` set. */
  readonly reveal?: Reveal;
  /**
   * Where `@dunx/openapi` serves its explorer, so the routes panel can link a row
   * to the operation that documents it. A string, not a dependency: the two
   * packages describe the same routes for different audiences and a link is free,
   * where importing one into the other is not.
   */
  readonly openApiPath?: string;
  /**
   * How often the live panels re-fetch, in milliseconds. `0` turns polling off and
   * leaves the refresh button.
   *
   * Polling rather than a websocket, deliberately: the page is stateless, a gateway
   * would put the dashboard in the app's own upgrade table, and 5 s is well inside
   * what "how many jobs are failing" needs.
   *
   * @default 5000
   */
  readonly pollMs?: number;
  /**
   * How long a probe may take before it is reported `unknown`. A hung probe must
   * cost one light, not the page.
   *
   * @default 2000
   */
  readonly probeTimeoutMs?: number;
  /**
   * Whether the queue board may change anything.
   *
   * Passed through to **bull-board's own `readOnlyMode`** rather than enforced
   * here: it already has the switch, and a second implementation would disagree
   * with it the moment bull-board grew an operation dunx had not heard of.
   *
   * The rest of the dashboard is read-only regardless - it reports on the process
   * and never acts on it - so this is entirely about the queues page. `authorize`
   * gates who reaches the mount; this gates what they can do once there.
   *
   * @default true
   */
  readonly commands?: boolean;
}

/**
 * A class, not an interface, so it is a runtime value and can therefore be a
 * constructor parameter type that `@dunx/transform` records - the same reason
 * `QueueOptions` and `RedisOptions` are classes.
 */
export class DashboardOptions {
  readonly path: string;
  readonly authorize: Authorize | undefined;
  readonly title: string;
  readonly queues: QueueSource | undefined;
  readonly queueNames: readonly string[];
  readonly redis: RedisProbe | undefined;
  readonly probes: readonly DashboardProbe[];
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
 *
 * `/` itself is rejected: mounting the dashboard at the root would swallow every
 * unmatched path in the app, and the middleware's whole contract is that anything
 * outside its mount falls through untouched.
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
