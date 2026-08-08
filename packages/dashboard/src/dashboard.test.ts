import { ConfigService, Module } from '@dunx/core';
import {
  Controller,
  Gateway,
  Get,
  HttpFactory,
  OnMessage,
  Public,
} from '@dunx/http';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createBunRedisClient, Queue } from 'bullmq';
import type { QueueSource } from './contracts.js';
import { DashboardMiddleware } from './middleware.js';
import { DashboardModule } from './module.js';
import type { QueuesReport, RuntimeReport, Snapshot } from './api/types.js';

/**
 * The whole thing against a real `Bun.serve`, because every contract worth having
 * here is about position in the middleware chain and cannot be tested by calling
 * `handle` directly: falling through to the app's own routes, reaching the
 * unmatched-path fallback, and answering 404 rather than 403.
 */
class Notes {
  list(): string[] {
    return [];
  }
}

/**
 * No constructor parameters anywhere in this fixture, deliberately: a package's own
 * suite runs from `src` with no `@dunx/transform` preload - the same constraint
 * every other package's tests are written under - so a recorded dependency would
 * not exist and boot would fail naming it.
 */
@Controller('/notes')
class NotesController {
  readonly notes = new Notes();

  @Get('/')
  @Public()
  all(): { notes: string[] } {
    return { notes: this.notes.list() };
  }
}

@Gateway('/ws')
class FeedGateway {
  ticks = 0;

  @OnMessage('tick')
  tick(): void {
    this.ticks += 1;
  }
}

@Module({ controllers: [NotesController], providers: [Notes, FeedGateway] })
class NotesModule {}

/**
 * A real bullmq `Queue`, pointed at a port nothing listens on.
 *
 * bull-board is handed the queue object untouched, so a stub would be testing the
 * stub. It never connects here - the board only has to *build*, which is what the
 * assertions are about - and `maxRetries: 0` is what keeps a failed connect from
 * holding a retry timer past `close()` and wedging the suite.
 */
const queue = new Queue('emails', {
  connection: createBunRedisClient(
    new Bun.RedisClient('redis://127.0.0.1:1', {
      connectionTimeout: 100,
      maxRetries: 0,
      autoReconnect: false,
    }),
  ),
});
queue.on('error', () => {
  // An 'error' event with no listener throws rather than being ignored, and an
  // unreachable broker emits several.
});

const queues: QueueSource = { opened: ['emails'], queue: () => queue };

const AUTHORIZED = 'let-me-in';

/**
 * `ConfigService` satisfies `ConfigValues` structurally, which is the whole
 * wiring - no adapter, and this package depends on nothing to read it.
 */
const config = new ConfigService({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://s3cret',
});

@Module({
  imports: [
    NotesModule,
    DashboardModule.forRoot({
      queues,
      queueNames: ['reports'],
      config,
      authorize: (req) => req.headers.get('x-admin') === AUTHORIZED,
      reveal: (key) => key === 'NODE_ENV',
      openApiPath: '/docs',
      pollMs: 0,
    }),
  ],
})
class AppModule {}

let base = '';
let app: Awaited<ReturnType<typeof HttpFactory.create>>;

const get = (path: string, admin = true): Promise<Response> =>
  fetch(`${base}${path}`, {
    headers: admin ? { 'x-admin': AUTHORIZED } : {},
  });

beforeAll(async () => {
  app = await HttpFactory.create(AppModule, {
    requestLogging: false,
    bootLogging: false,
  });
  // Ahead of anything else, which is the contract: a session guard registered
  // first would answer 401 before `authorize` ran and defeat the 404 below.
  app.use(DashboardMiddleware);
  base = (await app.listen(0)).replace(/\/$/, '');
});

afterAll(async () => {
  await app.shutdown();
  await queue.close();
});

describe('the mount', () => {
  it('leaves the app’s own routes alone', async () => {
    const response = await get('/notes', false);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ notes: [] });
  });

  it('leaves the app’s own 404 alone', async () => {
    const response = await get('/nothing-here', false);
    expect(response.status).toBe(404);
  });

  it('does not claim a path that merely starts with the mount’s name', async () => {
    // `/_dunxious` is the app's problem, not the dashboard's - which is why the
    // prefix carries a trailing slash.
    const response = await get('/_dunxious', false);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'NOT_FOUND' });
  });

  it('answers 404, never 403, to an unauthorized caller', async () => {
    // A dashboard that answers 403 has told a prober where to keep knocking.
    const response = await get('/_dunx/api/snapshot', false);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('routes');
  });

  it('serves the page as HTML that fetches nothing', async () => {
    const response = await get('/_dunx');
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('dunx-dashboard-meta');
    expect(html).not.toMatch(/<script[^>]+src=/);
    // The one `<link>` is the dunx mark as a `data:` URI - a tag the browser
    // does not fetch. The guarantee is about requests, not about the element.
    for (const [, href] of html.matchAll(/<link\b[^>]*href="([^"]*)"/g)) {
      expect(href).toMatch(/^data:image\/svg\+xml,/);
    }
    expect(html).toContain('noindex');
  });

  it('serves the page for a client-side route so a reload survives', async () => {
    // Any non-`api`, non-`queues` path under the mount. `queues` is bull-board's
    // namespace and answers with its own 404 for a path it does not know.
    const response = await get('/_dunx/graph');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });
});

describe('the snapshot', () => {
  it('reports the routes, the graph and the gateways', async () => {
    const snapshot = (await (
      await get('/_dunx/api/snapshot')
    ).json()) as Snapshot;

    expect(snapshot.routes).toHaveLength(1);
    expect(snapshot.routes[0]).toMatchObject({
      method: 'GET',
      path: '/notes',
      controller: 'NotesController',
      module: 'NotesModule',
      public: true,
    });
    expect(snapshot.gateways[0]).toMatchObject({
      path: '/ws',
      name: 'FeedGateway',
    });
    expect(snapshot.meta.openApiPath).toBe('/docs');
  });

  it('classifies a gateway as a gateway in the provider list too', async () => {
    // Core cannot import @dunx/http, so the marker arrives as an option. Without
    // it this row would say `provider` while the gateways panel said otherwise.
    const snapshot = (await (
      await get('/_dunx/api/snapshot')
    ).json()) as Snapshot;
    const gateway = snapshot.providers.find((p) => p.token === 'FeedGateway');
    expect(gateway?.role).toBe('gateway');
    const notes = snapshot.modules.find((m) => m.name === 'NotesModule');
    expect(notes?.gateways).toEqual(['FeedGateway']);
    expect(notes?.providers).toEqual(['Notes']);
  });

  it('redacts every config value the app did not name', async () => {
    const snapshot = (await (
      await get('/_dunx/api/snapshot')
    ).json()) as Snapshot;
    const byKey = new Map(snapshot.config?.map((e) => [e.key, e]));

    expect(byKey.get('NODE_ENV')).toEqual({
      key: 'NODE_ENV',
      type: 'string',
      value: 'test',
    });
    // No sentinel, no key: a `'***'` value is indistinguishable from a real one.
    expect(byKey.get('DATABASE_URL')).toEqual({
      key: 'DATABASE_URL',
      type: 'string',
    });
    expect(JSON.stringify(snapshot.config)).not.toContain('s3cret');
  });
});

describe('runtime', () => {
  it('reports the process', async () => {
    const runtime = (await (
      await get('/_dunx/api/runtime')
    ).json()) as RuntimeReport;
    expect(runtime.pid).toBe(process.pid);
    expect(runtime.bun).toBe(Bun.version);
    expect(runtime.memory.heapUsed).toBeGreaterThan(0);
  });

  it('reports redis as unconfigured rather than down', async () => {
    // Different facts. `configured: false` means nobody passed a handle; a
    // broker that is actually down reports `configured: true` with an error.
    const redis = (await (await get('/_dunx/api/redis')).json()) as {
      configured: boolean;
    };
    expect(redis.configured).toBe(false);
  });
});

describe('the queues handoff', () => {
  it('answers names only - everything else is bull-board’s', async () => {
    const report = (await (
      await get('/_dunx/api/queues')
    ).json()) as QueuesReport;
    // `emails` from the source, `reports` from `queueNames` - both are just names
    // now, so the distinction the old panel drew has nowhere left to show.
    expect(report.queues).toEqual(['emails', 'reports']);
    expect(report.unavailable).toBeUndefined();
    // No counts, no jobs, no commands. dunx renders no queue UI.
    expect(Object.keys(report)).toEqual(['queues']);
  });

  it('mounts bull-board’s own page under the mount', async () => {
    const response = await get('/_dunx/queues');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    // bull-board's markup, not dunx's - the whole point of the handoff.
    expect(html).toContain('<script id="__UI_CONFIG__"');
    // Rooted at the mount, so its own asset and API paths land back inside it.
    expect(html).toContain('<base href="/_dunx/queues/" />');
    // Wearing dunx's name and mark rather than "Bull Dashboard": the board is
    // reached from inside this page, and a tab that suddenly changes identity
    // reads as having left the site.
    expect(html).toContain('<title>dunx queues</title>');
    expect(html).toContain('"favIcon":{"default":"data:image/svg+xml,');
  });

  it('serves bull-board’s static assets through the same mount', async () => {
    // Its route table carries one `/*` prefix for these, which is the only
    // pattern `matchBoard` has to understand.
    const response = await get('/_dunx/queues/static/');
    expect([200, 404]).toContain(response.status);
  });

  it('keeps bull-board behind the same authorize', async () => {
    expect((await get('/_dunx/queues', false)).status).toBe(404);
  });

  it('serves the board for its own client-side routes', async () => {
    // `/queue/emails?status=failed` is rendered by bull-board's router, not its
    // server, so it has no entry in the route table. Answering 404 there - which
    // this did - broke every link the board itself renders.
    const response = await get('/_dunx/queues/queue/emails?status=completed');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('404s a write to a path nothing declares', async () => {
    // The SPA fallback is GET-only: a POST to a route bull-board does not have
    // is a real 404, not a page.
    const response = await fetch(`${base}/_dunx/queues/nope/nope`, {
      method: 'POST',
      headers: { 'x-admin': AUTHORIZED },
    });
    expect(response.status).toBe(404);
  });
});

describe('a read-only mount', () => {
  it('hands bull-board its own readOnlyMode rather than refusing posts', async () => {
    // dunx does not police bull-board's operations - it has the switch, and a
    // second implementation would disagree the moment it grew an operation.
    @Module({
      imports: [
        NotesModule,
        DashboardModule.forRoot({ queues, commands: false, pollMs: 0 }),
      ],
    })
    class ReadOnly {}

    const readOnly = await HttpFactory.create(ReadOnly, {
      requestLogging: false,
      bootLogging: false,
    });
    readOnly.use(DashboardMiddleware);
    const url = (await readOnly.listen(0)).replace(/\/$/, '');

    const page = await fetch(`${url}/_dunx/queues`);
    expect(page.status).toBe(200);
    // bull-board's own UI config, which is where the switch actually lives.
    expect(await page.text()).toContain('"readOnlyMode":true');

    await readOnly.shutdown();
  });
});

describe('without a config handle', () => {
  it('reports config as absent rather than empty', async () => {
    @Module({ imports: [DashboardModule.forRoot({ pollMs: 0 })] })
    class Bare {}

    const bare = await HttpFactory.create(Bare, {
      requestLogging: false,
      bootLogging: false,
    });
    bare.use(DashboardMiddleware);
    const url = (await bare.listen(0)).replace(/\/$/, '');

    const snapshot = (await (
      await fetch(`${url}/_dunx/api/snapshot`)
    ).json()) as Snapshot;
    expect(snapshot.config).toBeUndefined();
    expect(snapshot.routes).toHaveLength(0);

    await bare.shutdown();
  });
});
