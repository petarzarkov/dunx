import { describe, expect, it } from 'bun:test';
import type {
  AppControllerRoute,
  AppViewRoute,
  BullBoardQueues,
} from '@bull-board/api/typings/app';
import { BunServeAdapter } from './adapter.js';

/**
 * The adapter is the part dunx wrote, so it is tested without bull-board: routes,
 * a view and an error handler are fed in by hand, exactly as bull-board would push
 * them, and the assertions are about what comes back out over HTTP.
 */
const render = async (
  viewPath: string,
  params: Record<string, unknown>,
): Promise<string> => `<html data-view="${viewPath}">${params['title']}</html>`;

const queues = {} as BullBoardQueues;

const build = (basePath = '/queues'): BunServeAdapter => {
  const adapter = new BunServeAdapter(basePath, render);
  adapter.setQueues(queues);
  adapter.setUIConfig({ boardTitle: 'Queues' });
  adapter.setViewsPath('/views');
  adapter.setEntryRoute({
    method: 'get',
    route: '/',
    handler: () => ({ name: 'index.ejs', params: { title: 'Board' } }),
  } as unknown as AppViewRoute);
  adapter.setApiRoutes([
    {
      method: 'get',
      route: '/api/queues',
      handler: () => ({ status: 200, body: { queues: [] } }),
    },
    {
      method: ['post', 'put'],
      route: '/api/queues/:queueName/:id/retry',
      handler: ({
        params,
        body,
      }: {
        params: Record<string, string>;
        body: unknown;
      }) => ({
        status: 200,
        body: { params, body },
      }),
    },
    {
      method: 'get',
      route: '/api/boom',
      handler: () => {
        throw new Error('handler exploded');
      },
    },
    {
      method: 'delete',
      route: '/api/queues/:queueName',
      handler: () => ({ status: 204 }),
    },
  ] as unknown as AppControllerRoute[]);
  adapter.setErrorHandler((error) => ({ status: 500, body: error.message }));
  return adapter;
};

const get = (path: string, init?: RequestInit): Request =>
  new Request(`http://app.test${path}`, init);

describe('mounting', () => {
  it('answers the entry route at the mount path', async () => {
    const response = await build().handle(get('/queues'));
    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toContain('text/html');
    expect(await response?.text()).toBe(
      '<html data-view="/views/index.ejs">Board</html>',
    );
  });

  /** Falling through is what lets the app's own 404 answer, not the board's. */
  it('returns undefined for a path outside the mount', async () => {
    expect(await build().handle(get('/users'))).toBeUndefined();
    expect(await build().handle(get('/'))).toBeUndefined();
  });

  /** `/queuesomething` starts with `/queues` as a string but is not under it. */
  it('does not claim a path that merely shares the prefix', async () => {
    expect(await build().handle(get('/queuesomething'))).toBeUndefined();
  });

  it('serves from the root when mounted at /', async () => {
    const response = await build('/').handle(get('/'));
    expect(response?.status).toBe(200);
  });

  it('returns undefined for an unknown path under the mount', async () => {
    expect(await build().handle(get('/queues/nope'))).toBeUndefined();
  });
});

describe('api routes', () => {
  it('answers a GET with JSON', async () => {
    const response = await build().handle(get('/queues/api/queues'));
    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toContain('application/json');
    expect(await response?.json()).toEqual({ queues: [] });
  });

  it('decodes path parameters and passes the body through', async () => {
    const response = await build().handle(
      get('/queues/api/queues/my%20queue/42/retry', {
        method: 'POST',
        body: JSON.stringify({ force: true }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(await response?.json()).toEqual({
      params: { queueName: 'my queue', id: '42' },
      body: { force: true },
    });
  });

  /** The UI sends most mutations with no body, so a parse failure is routine. */
  it('treats a missing or invalid body as empty', async () => {
    const response = await build().handle(
      get('/queues/api/queues/q/1/retry', { method: 'POST' }),
    );
    expect(await response?.json()).toMatchObject({ body: {} });
  });

  it('registers every method a route declares', async () => {
    for (const method of ['POST', 'PUT']) {
      const response = await build().handle(
        get('/queues/api/queues/q/1/retry', { method }),
      );
      expect(response?.status).toBe(200);
    }
  });

  it('does not match a declared route under the wrong method', async () => {
    expect(
      await build().handle(get('/queues/api/queues', { method: 'POST' })),
    ).toBeUndefined();
  });

  it('sends no body for a 204', async () => {
    const response = await build().handle(
      get('/queues/api/queues/q', { method: 'DELETE' }),
    );
    expect(response?.status).toBe(204);
    expect(await response?.text()).toBe('');
  });

  it("routes a throwing handler through bull-board's error handler", async () => {
    const response = await build().handle(get('/queues/api/boom'));
    expect(response?.status).toBe(500);
    expect(await response?.text()).toBe('handler exploded');
  });
});

describe('static assets', () => {
  const withStatics = async (): Promise<BunServeAdapter> => {
    const adapter = build();
    // The package's own directory is a real tree to serve from, so the assertions
    // are about file serving rather than about a mock.
    adapter.setStaticPath('/static', `${import.meta.dir}`);
    return adapter;
  };

  it('serves a real file with an immutable cache header', async () => {
    const response = await (
      await withStatics()
    ).handle(get('/queues/static/adapter.ts'));
    expect(response?.status).toBe(200);
    expect(response?.headers.get('cache-control')).toContain('immutable');
    expect(await response?.text()).toContain('BunServeAdapter');
  });

  it('falls through for a file that is not there', async () => {
    expect(
      await (await withStatics()).handle(get('/queues/static/absent.js')),
    ).toBeUndefined();
  });

  /**
   * A dashboard that serves `../../.env` is worse than no dashboard, and the two
   * traversal spellings are stopped by different things - measured, because
   * assuming one guard covered both is how the encoded form gets through.
   *
   * A literal `..` never reaches the adapter: `new URL()` resolves it, so
   * `/queues/static/../../../package.json` arrives as `/package.json`, which is not
   * under the mount at all and falls through to the app.
   */
  it('never resolves a literal .. inside the mount', async () => {
    const response = await (
      await withStatics()
    ).handle(get('/queues/static/../../../package.json'));
    expect(response).toBeUndefined();
  });

  /** The percent-encoded form survives URL parsing, so the guard is what stops it. */
  it('refuses a percent-encoded traversal', async () => {
    const response = await (
      await withStatics()
    ).handle(get('/queues/static/..%2f..%2f..%2fpackage.json'));
    expect(response?.status).toBe(403);
  });
});
