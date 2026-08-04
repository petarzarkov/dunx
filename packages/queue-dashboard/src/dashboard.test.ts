import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Controller, Get, HttpFactory, type HttpApp } from '@dunx/http';
import { Module } from '@dunx/core';
import { Queue } from 'bullmq';
import { QueueDashboardMiddleware } from './middleware.js';
import { QueueDashboardModule } from './module.js';

/**
 * The real thing: a dunx app, a real bullmq `Queue` on a real broker, and the actual
 * `@bull-board/api` + `@bull-board/ui` serving over `Bun.serve`. A mocked bull-board
 * would assert this file's idea of the adapter contract rather than bull-board's.
 *
 * Skipped when no broker is reachable, printing why and still passing - the
 * repo-wide convention for a suite whose backing service CI may not have.
 */
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

const reachable = await (async (): Promise<boolean> => {
  const client = new Bun.RedisClient(REDIS_URL, { connectionTimeout: 500 });
  try {
    await client.connect();
    client.close();
    return true;
  } catch {
    return false;
  }
})();

if (!reachable) {
  console.log(
    `[queue-dashboard] skipping the end-to-end suite: no broker at ${REDIS_URL}`,
  );
}

const url = new URL(REDIS_URL);
const connection = {
  host: url.hostname,
  port: Number(url.port || 6379),
};

let app: HttpApp;
let base: string;
let queue: Queue;
let allow = true;

@Controller('/')
class AppController {
  @Get('/health')
  health(): { ok: boolean } {
    return { ok: true };
  }
}

beforeAll(async () => {
  if (!reachable) return;
  queue = new Queue('dashboard-test', { connection });
  await queue.waitUntilReady();
  await queue.add('sample', { hello: 'world' });

  @Module({
    controllers: [AppController],
    imports: [
      QueueDashboardModule.forRoot({
        path: '/queues',
        queues: [queue],
        uiConfig: { boardTitle: 'dunx queues' },
        // Flipped per test, so authorisation is exercised without two apps.
        authorize: () => allow,
      }),
    ],
  })
  class AppModule {}

  app = await HttpFactory.create(AppModule, { requestLogging: false });
  app.use(QueueDashboardMiddleware);
  base = await app.listen(0);
});

afterAll(async () => {
  if (!reachable) return;
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  await app.shutdown();
});

describe.if(reachable)('the mounted dashboard', () => {
  it('renders the board, through the real ejs template', async () => {
    const response = await fetch(`${base}queues`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const html = await response.text();
    // Proof the real @bull-board/ui index.ejs rendered, with the config applied.
    expect(html).toContain('<title>dunx queues</title>');
    // The template links assets *relatively* under a <base>, so the mount path has
    // to reach the template as the base href or every asset 404s.
    expect(html).toContain('<base href="/queues/" />');
    expect(html).toContain('static/');
  });

  it('answers the queues API with the real queue', async () => {
    const response = await fetch(`${base}queues/api/queues`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      queues: { name: string; counts: Record<string, number> }[];
    };
    const found = body.queues.find((q) => q.name === 'dashboard-test');
    expect(found).toBeDefined();
    // The job added in beforeAll is waiting, so bull-board sees real state.
    expect(found?.counts['waiting']).toBeGreaterThanOrEqual(1);
  });

  it('serves a real UI asset from @bull-board/ui', async () => {
    const html = await (await fetch(`${base}queues`)).text();
    // Relative in the template, resolved against the <base>, so the request is
    // built the same way a browser would build it.
    const asset = /static\/[^"']+\.(?:js|css)/.exec(html)?.[0];
    expect(asset).toBeDefined();

    const response = await fetch(`${base}queues/${asset}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect((await response.text()).length).toBeGreaterThan(1000);
  });

  /** The app's own routes must be untouched by a global middleware. */
  it('leaves the app routes alone', async () => {
    expect(await (await fetch(`${base}health`)).json()).toEqual({ ok: true });
  });

  it('falls through to the app 404 outside the mount', async () => {
    const response = await fetch(`${base}not-a-route`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'NOT_FOUND' });
  });

  /**
   * 404 rather than 403: a queue dashboard that announces itself to an
   * unauthenticated caller has told them where to keep knocking.
   */
  it('hides the board when authorize returns false', async () => {
    allow = false;
    try {
      expect((await fetch(`${base}queues`)).status).toBe(404);
      expect((await fetch(`${base}queues/api/queues`)).status).toBe(404);
      // And the app is still reachable.
      expect((await fetch(`${base}health`)).status).toBe(200);
    } finally {
      allow = true;
    }
  });
});
