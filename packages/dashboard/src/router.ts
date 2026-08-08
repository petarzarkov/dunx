import type { ModuleRef } from '@dunx/core';
import { boardNames, matchBoard, type Board } from './board.js';
import { redisReport } from './api/redis.js';
import { runtimeReport } from './api/runtime.js';
import { snapshotOf } from './api/snapshot.js';
import type { DashboardOptions } from './options.js';

/**
 * What the mount answers, and nothing else. A path outside it never reaches here -
 * the middleware calls `next()` - which is what keeps the app's own routes and its
 * 404 behaving exactly as before.
 *
 * Three kinds of thing live under the mount:
 *
 * - `/` and any other non-`api`, non-`queues` path serve the page, so a client-side
 *   route survives a reload.
 * - `/api/*` are dunx's own JSON endpoints. Every panel has one, and they are
 *   supported rather than an implementation detail of the page - `curl` is a real
 *   way to read this.
 * - `/queues/*` is **bull-board's**, dispatched against its own route table. dunx
 *   renders no queue UI; see `board.ts`.
 */

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    // The page and its data are the same origin and the same process; a cached
    // runtime report is a lie with a timestamp on it.
    headers: { 'cache-control': 'no-store' },
  });

/** The one shape every failure inside the mount takes. */
const fail = (status: number, error: string): Response =>
  json({ error }, status);

export interface RouterDeps {
  readonly root: ModuleRef;
  readonly options: DashboardOptions;
  readonly startedAt: number;
  /** The HTML page, built lazily so importing this package does not load it. */
  readonly page: () => Promise<string>;
  /** bull-board, built lazily so an app that never opens it holds no socket. */
  readonly board: () => Promise<Board>;
}

const handleApi = async (
  deps: RouterDeps,
  method: string,
  segments: readonly string[],
): Promise<Response> => {
  if (method !== 'GET') return fail(405, `${method} is not allowed here`);

  switch (segments[0]) {
    case 'snapshot':
      return json(snapshotOf(deps.root, deps.options));
    case 'runtime':
      return json(await runtimeReport(deps.options, deps.startedAt));
    case 'redis':
      return json(
        deps.options.redis === undefined
          ? { configured: false }
          : await redisReport(deps.options.redis, deps.options.probeTimeoutMs),
      );
    case 'queues': {
      // Names only, read straight off the options - **not** through `deps.board()`,
      // which would open a connection per queue. The page polls this to decide
      // whether to offer the link, and a poll must not have side effects.
      const { names, unavailable } = boardNames(deps.options);
      return json({
        queues: names,
        ...(unavailable === undefined ? {} : { unavailable }),
      });
    }
    default:
      return fail(404, 'no such dashboard endpoint');
  }
};

/**
 * `rest` is the path with the mount already stripped: `''` for the page itself,
 * `api/runtime` for a data call, `queues/...` for bull-board.
 */
export const handleDashboard = async (
  deps: RouterDeps,
  request: Request,
  rest: string,
): Promise<Response> => {
  const segments = rest.split('/').filter(Boolean);
  const { method } = request;

  if (segments[0] === 'api') {
    try {
      return await handleApi(deps, method, segments.slice(1));
    } catch (error) {
      // Nothing inside the mount may throw into the app's error mapper: a
      // dashboard read that failed is a dashboard problem, and a 500 shaped like
      // the app's own errors would send someone looking in the wrong place.
      return fail(500, error instanceof Error ? error.message : String(error));
    }
  }

  if (segments[0] === 'queues') {
    const board = await deps.board();
    if (board.routes === undefined) {
      return fail(503, board.unavailable ?? 'no queue board');
    }
    const handler = matchBoard(
      board.routes,
      method,
      new URL(request.url).pathname,
    );
    // bull-board's own 404, not the app's: a path under its mount that it does
    // not recognise is its business.
    if (handler === undefined) return fail(404, 'no such bull-board route');
    return handler(request);
  }

  if (method !== 'GET') return fail(405, `${method} is not allowed here`);

  return new Response(await deps.page(), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
};
