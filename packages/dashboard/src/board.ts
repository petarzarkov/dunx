import type { DashboardOptions } from './options.js';

/**
 * bull-board, mounted. **dunx renders no queue UI of its own.**
 *
 * This package briefly did - a table over `getJobCounts`, `getJobs` and seven
 * commands - and that was the wrong call under Rule 1's second half: never invent
 * what a mature library already solves. bull-board is years of edge cases with
 * flows, job logs, the repeatable-job editor, per-queue metrics, redis stats and a
 * pause/retry/clean surface nobody is going to re-derive correctly.
 *
 * The reason it was hand-rolled was that mounting bull-board on `Bun.serve` meant
 * writing a `BunServeAdapter` to satisfy its interface, which the deleted
 * `@dunx/queue-dashboard` did and which was a liability. **That reason expired:**
 * bull-board 8.6.0 ships `@bull-board/bun`, an official `BunAdapter`. So the
 * integration is now three calls and dunx owns none of the queue surface - which is
 * also what surfaced the `getWorkers()` bug: bull-board asks the question dunx's own
 * panel had decided not to, and the answer turned out to be wrong for a reason in
 * `@dunx/infra/queue`. See `QueueConnection.#handleErrors`.
 *
 * All three packages are **optional peers**. An app with no queues installs none of
 * them and the board is simply absent, with the queues nav item explaining why.
 */

/** bull-board's `BaseAdapter`, restated to the one thing this file does with it. */
interface QueueAdapter {
  readonly name?: string;
}

/** The Bun route table `BunAdapter.getRoutes()` produces. */
export type BoardRoutes = Record<
  string,
  Record<string, (req: Request) => Response | Promise<Response>>
>;

interface BullBoardModules {
  readonly createBullBoard: (config: {
    queues: readonly QueueAdapter[];
    serverAdapter: unknown;
    options?: { uiConfig: BoardUiConfig };
  }) => unknown;
  readonly BullMQAdapter: new (queue: unknown) => QueueAdapter;
  readonly BunAdapter: new () => {
    setBasePath(path: string): unknown;
    setQueues(queues: unknown): unknown;
    getRoutes(): BoardRoutes;
  };
}

/**
 * Loaded with `await import` inside a `try`, because all three are optional peers
 * and "not installed" is a normal state rather than a failure. The message names
 * the exact install line, since a missing optional peer is otherwise a stack trace
 * about a module specifier.
 */
const load = async (): Promise<BullBoardModules | undefined> => {
  try {
    const [api, bullmq, bun] = await Promise.all([
      import('@bull-board/api'),
      import('@bull-board/api/bullMQAdapter'),
      import('@bull-board/bun'),
    ]);
    // `as unknown as` throughout, and deliberately. These are **optional peers**
    // whose types are present when installed and absent when not, so this module
    // has to describe the surface it uses rather than import theirs - and the
    // structural distance between a hand-written description and bull-board's
    // real generics is exactly what a direct assertion refuses.
    return {
      createBullBoard:
        api.createBullBoard as unknown as BullBoardModules['createBullBoard'],
      BullMQAdapter:
        bullmq.BullMQAdapter as unknown as BullBoardModules['BullMQAdapter'],
      BunAdapter: bun.BunAdapter as unknown as BullBoardModules['BunAdapter'],
    };
  } catch {
    return undefined;
  }
};

export interface Board {
  /** Why there is no board, for the page to show. Absent when there is one. */
  readonly unavailable?: string;
  readonly routes?: BoardRoutes;
  /** The entry route, so an unmatched client-side path serves the page. */
  readonly entry?: (req: Request) => Response | Promise<Response>;
  /** The queue names the board was built with, for the nav. */
  readonly queues: readonly string[];
}

/**
 * bull-board wants **queue objects**, not names, and `QueueSource.queue(name)`
 * opens one - so this is the one place the dashboard touches a broker. It happens
 * on the first request for the board and is memoised by the caller, not at boot: an
 * app that mounts the dashboard and never opens the queues page must not hold a
 * socket for it.
 */
/**
 * The names alone, answerable **without opening anything**.
 *
 * That separation is the whole reason `/_dunx/api/queues` and `/_dunx/queues` are
 * different endpoints: the page asks this one on every poll to decide whether to
 * offer the link, and it must not open a socket to answer. Only somebody actually
 * opening the board does that.
 */
export const boardNames = (
  options: DashboardOptions,
): { readonly names: readonly string[]; readonly unavailable?: string } => {
  if (options.queues === undefined) {
    return {
      names: [],
      unavailable:
        'This app passed no `queues` to DashboardModule. `JobPublisher` from ' +
        '@dunx/infra/queue satisfies it as written.',
    };
  }

  const opened = options.queues.opened;
  const names = [
    ...opened,
    ...options.queueNames.filter((name) => !opened.includes(name)),
  ].sort();

  if (names.length === 0) {
    return {
      names,
      unavailable:
        'This process has opened no queues. A queue it only consumes has never ' +
        'been opened by the publisher - name it in DashboardOptions.queueNames.',
    };
  }
  return { names };
};

/**
 * bull-board's own `uiConfig`, which is where its title and tab icon come from.
 *
 * Set rather than left at "Bull Dashboard", because the board is reached from
 * inside this app's dashboard and a page that suddenly changes name and logo reads
 * as having left the site. The mark is `@dunx/ui`'s single declaration of it,
 * passed as a `data:` URI so bull-board fetches nothing for it either.
 *
 * `boardLogo` **and** `favIcon`: the first is the header, the second the tab, and
 * setting only one leaves the page half-branded.
 */
interface BoardUiConfig {
  readonly readOnlyMode: boolean;
  readonly boardTitle: string;
  /** The mark **in the board's own header**, beside the title. */
  readonly boardLogo: { path: string; width?: number; height?: number };
  /** The tab icon. Two cuts, because bull-board offers an SVG/PNG pair. */
  readonly favIcon: { default: string; alternative: string };
}

const uiConfigFor = (
  options: DashboardOptions,
  favicon: string,
): BoardUiConfig => ({
  readOnlyMode: !options.commands,
  boardTitle: `${options.title} queues`,
  // Both, not just the tab: `boardLogo` is the mark in bull-board's own header,
  // which is what actually makes the page look like part of this app rather than
  // a different product someone linked to.
  boardLogo: { path: favicon, width: 26, height: 26 },
  favIcon: { default: favicon, alternative: favicon },
});

export const buildBoard = async (
  options: DashboardOptions,
  basePath: string,
  favicon: string,
): Promise<Board> => {
  const { names, unavailable } = boardNames(options);

  if (unavailable !== undefined || options.queues === undefined) {
    return { unavailable: unavailable ?? 'no queue source', queues: names };
  }

  const modules = await load();
  if (modules === undefined) {
    return {
      unavailable:
        'bull-board is not installed. It is an optional peer, so add it with ' +
        '`bun add @bull-board/api @bull-board/ui @bull-board/bun`.',
      queues: names,
    };
  }

  const { createBullBoard, BullMQAdapter, BunAdapter } = modules;
  const source = options.queues;
  const serverAdapter = new BunAdapter();
  serverAdapter.setBasePath(basePath);

  createBullBoard({
    queues: names.map((name) => new BullMQAdapter(source.queue(name))),
    serverAdapter,
    // `commands: false` maps straight onto bull-board's own `readOnlyMode` rather
    // than dunx refusing the POSTs itself. Enforcing it here would be a second
    // implementation of a switch the library already has, and one that disagreed
    // the moment bull-board grew an operation dunx had not heard of.
    options: { uiConfig: uiConfigFor(options, favicon) },
  });

  const routes = serverAdapter.getRoutes();
  // bull-board is a single-page app with its own router, so a path it renders
  // client-side - `/queue/emails?status=failed` - has no entry in the table. Its
  // own base route is what serves that, exactly as the dashboard's mount serves
  // its own panels.
  const entry = routes[basePath]?.['GET'];
  return {
    routes,
    queues: names,
    ...(entry === undefined ? {} : { entry }),
  };
};

/**
 * Bun's route patterns, matched against a path.
 *
 * bull-board's table is not a list of literals - it carries `:queueName`,
 * `:jobId`, `:queueStatus` and a `static/*` prefix, thirty-odd patterns in all.
 * The first version of this did exact-match plus one wildcard and 404'd every
 * job view and every per-queue API call, which is the bug that produced
 * `{"error":"no such bull-board route"}` on a page bull-board itself renders.
 *
 * This **is** a small path matcher, and dunx bans writing one - for the app's
 * routes, where `Bun.serve({ routes })` does it natively and better. It cannot
 * here: the board is built on the first request for it, long after `listen()`
 * folded the route table, so there is nothing to hand these to. The compensation
 * is that it never sees an app's routes, only the table bull-board handed over.
 */
interface Pattern {
  readonly segments: readonly string[];
  readonly wildcard: boolean;
  /** Literal segments, so a literal route beats a parameterised one. */
  readonly literals: number;
  readonly handlers: Record<
    string,
    (req: Request) => Response | Promise<Response>
  >;
}

const compile = (routes: BoardRoutes): readonly Pattern[] =>
  Object.entries(routes)
    .map(([pattern, handlers]) => {
      const raw = pattern.split('/').filter(Boolean);
      const wildcard = raw.at(-1) === '*';
      const segments = wildcard ? raw.slice(0, -1) : raw;
      return {
        segments,
        wildcard,
        literals: segments.filter((s) => !s.startsWith(':')).length,
        handlers,
      };
    })
    // Most literal first, then longest. `/api/queues` must win over
    // `/api/queues/:queueName` for a path both could claim, and a wildcard is
    // the last thing tried.
    .sort(
      (a, b) =>
        b.literals - a.literals ||
        b.segments.length - a.segments.length ||
        Number(a.wildcard) - Number(b.wildcard),
    );

/**
 * The params if it matches, `undefined` if it does not - an empty object is a
 * match with no parameters, which is a different answer.
 */
const matchParams = (
  pattern: Pattern,
  path: readonly string[],
): Record<string, string> | undefined => {
  if (pattern.wildcard) {
    if (path.length < pattern.segments.length) return undefined;
  } else if (path.length !== pattern.segments.length) {
    return undefined;
  }

  const params: Record<string, string> = {};
  for (const [index, segment] of pattern.segments.entries()) {
    const value = path[index] ?? '';
    if (segment.startsWith(':')) {
      // Decoded, because a queue name may legitimately carry a space or a slash
      // and arrives percent-encoded. Bun does the same for its own params.
      params[segment.slice(1)] = decodeURIComponent(value);
    } else if (segment !== value) {
      return undefined;
    }
  }
  return params;
};

/**
 * Dispatches against bull-board's **own** route table - an exact path match, plus
 * the one `/*` prefix its static assets are served under.
 *
 * This is not the JavaScript router dunx bans. It never sees an app's routes: Bun
 * still matches everything real, this runs only inside the dashboard mount, and the
 * table it walks is the one bull-board handed over. Twenty lines here is the price
 * of not asking `HttpFactory` to accept a foreign route table at boot.
 */
export interface BoardMatch {
  readonly handler: (req: Request) => Response | Promise<Response>;
  /**
   * What `Bun.serve` would have put on `BunRequest.params`.
   *
   * bull-board's handlers read `request.params` - Bun populates it when *it*
   * matches a route pattern, and nothing populates it when the dispatch is
   * manual. Without this every parameterised route answered
   * `{"error":{"key":"ERRORS.QUEUE_NOT_FOUND"}}`: the route was found, the queue
   * name was not.
   */
  readonly params: Record<string, string>;
}

export const matchBoard = (
  routes: BoardRoutes,
  method: string,
  pathname: string,
): BoardMatch | undefined => {
  // The literal case is most of the traffic and costs one lookup.
  const exact = routes[pathname]?.[method];
  if (exact) return { handler: exact, params: {} };

  const path = pathname.split('/').filter(Boolean);
  for (const pattern of compile(routes)) {
    const params = matchParams(pattern, path);
    if (params === undefined) continue;
    const handler = pattern.handlers[method];
    if (handler) return { handler, params };
  }
  return undefined;
};
