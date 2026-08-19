import { expect, test } from 'bun:test';
import { Module, type OnBeforeShutdown, type OnShutdown } from '@dunx/core';
import { Controller, Get } from '../route/decorators.js';
import { HttpFactory } from './factory.js';

/**
 * `shutdown()` stops the server before the container tears down, which is stated
 * where it happens and is correct for teardown. It left nowhere for work that has
 * to be observable from outside: a readiness probe must start failing while the
 * port is still open, or a load balancer is still routing when the socket goes
 * away. `onBeforeShutdown` is that phase, and this asserts a route still answers from it.
 *
 * The opposite case is not asserted. A `fetch` after `stop()` can still succeed on
 * a pooled keep-alive connection, so "unreachable from `onShutdown`" measures Bun's
 * socket reuse rather than dunx's ordering. The order itself is asserted instead.
 */
const order: string[] = [];
let status = 0;
let base = '';

@Controller('ping')
class PingController {
  @Get('/')
  ping(): { ok: true } {
    return { ok: true };
  }
}

class Lifecycle implements OnBeforeShutdown, OnShutdown {
  async onBeforeShutdown(): Promise<void> {
    order.push('drain');
    status = (await fetch(`${base}ping`)).status;
  }

  onShutdown(): void {
    order.push('shutdown');
  }
}

@Module({ controllers: [PingController], providers: [Lifecycle] })
class Root {}

test('a route still answers from a drain hook', async () => {
  const app = await HttpFactory.create(Root, { requestLogging: false });
  // Resolved so the hooks exist: an unasked-for provider is never constructed.
  app.get(Lifecycle);

  base = await app.listen(0);
  expect((await fetch(`${base}ping`)).status).toBe(200);

  await app.shutdown();

  expect(status).toBe(200);
  expect(order).toEqual(['drain', 'shutdown']);
});
