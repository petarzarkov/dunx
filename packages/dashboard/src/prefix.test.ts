import { Module } from '@dunx/core';
import {
  Controller,
  Gateway,
  Get,
  HttpFactory,
  OnMessage,
  Public,
} from '@dunx/http';
import { afterAll, beforeAll, expect, it } from 'bun:test';
import { DashboardMiddleware } from './middleware.js';
import { DashboardModule } from './module.js';
import type { Snapshot } from './api/types.js';

/**
 * The route panel under a global prefix.
 *
 * `routesOf` walks prototypes, so it reads the path a `@Get` declared. The prefix
 * is applied at `listen()`, which meant the panel reported `/notes` for a route
 * the server answers at `/api/notes`: an operator copying a path out of the
 * dashboard got a 404. Every other suite here mounts with no prefix, which is why
 * it went unseen.
 *
 * Gateways are the other half and they are **not** prefixed: `listen()` builds the
 * upgrade table from `ws.paths` untouched, so `/ws` is `/ws` whatever the routes
 * carry. A fix that prefixed both would break the panel it was fixing.
 */
const PREFIX = 'api';

@Controller('/notes')
class NotesController {
  @Get('/')
  @Public()
  all(): { notes: string[] } {
    return { notes: [] };
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

@Module({ controllers: [NotesController], providers: [FeedGateway] })
class NotesModule {}

@Module({
  imports: [
    NotesModule,
    DashboardModule.forRoot({ path: `/${PREFIX}/_dunx`, pollMs: 0 }),
  ],
})
class AppModule {}

let base = '';
let app: Awaited<ReturnType<typeof HttpFactory.create>>;

const snapshot = async (): Promise<Snapshot> => {
  const response = await fetch(`${base}/${PREFIX}/_dunx/api/snapshot`);
  expect(response.status).toBe(200);
  return (await response.json()) as Snapshot;
};

beforeAll(async () => {
  app = await HttpFactory.create(AppModule, {
    requestLogging: false,
    bootLogging: false,
    prefix: PREFIX,
  });
  app.use(DashboardMiddleware);
  base = (await app.listen(0)).replace(/\/$/, '');
});

afterAll(async () => {
  await app.shutdown();
});

it('serves the app route under the prefix', async () => {
  const response = await fetch(`${base}/${PREFIX}/notes`);

  expect(response.status).toBe(200);
  // The unprefixed path is not served, which is what makes reporting it a defect
  // rather than a shorthand.
  expect((await fetch(`${base}/notes`)).status).toBe(404);
});

it('reports the route path the server actually answers', async () => {
  const { routes } = await snapshot();

  expect(routes.map((route) => route.path)).toContain(`/${PREFIX}/notes`);
});

it('reports no route path that is not served', async () => {
  const { routes } = await snapshot();

  for (const route of routes) {
    const response = await fetch(`${base}${route.path}`, {
      method: route.method,
    });
    // Every path in the panel has to be reachable. A 404 here is the panel
    // naming something the router does not have.
    expect(response.status).not.toBe(404);
  }
});

it('leaves gateway paths unprefixed, because listen() does', async () => {
  const { gateways } = await snapshot();

  expect(gateways.map((gateway) => gateway.path)).toEqual(['/ws']);
});

it('upgrades at the gateway path the panel reported', async () => {
  const { gateways } = await snapshot();
  const path = gateways[0]?.path ?? '';

  const upgraded = await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(`${base}${path}`.replace('http', 'ws'));
    const timer = setTimeout(() => resolve(false), 2000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      socket.close();
      resolve(true);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });

  expect(upgraded).toBe(true);
});
