import { expect, test } from 'bun:test';
import { Module } from '@dunx/core';
import { HttpFactory } from '../server/factory.js';
import { HealthIndicator, type ProbeResult } from './contracts.js';
import { HealthModule } from './module.js';

class Db extends HealthIndicator {
  readonly name = 'database';
  check(): ProbeResult {
    return { state: 'up', detail: '1 ms' };
  }
}

/**
 * The whole reason this feature needed a new lifecycle phase.
 *
 * A load balancer stops routing when readiness fails, and it notices on its own
 * schedule. So readiness has to fail *while the port is still open* and stay open
 * long enough to be noticed. Before `OnBeforeShutdown`, every hook ran after
 * `server.stop()` had resolved, so a probe answering from one answered on a closed
 * socket and traffic was still arriving when it went away.
 */
test('readiness fails while the port is still serving, then the port closes', async () => {
  @Module({
    imports: [
      HealthModule.forRoot({
        readiness: [new Db()],
        liveness: [new Db()],
        // Long enough to observe the window from outside.
        drainDelayMs: 400,
      }),
    ],
  })
  class Root {}

  const app = await HttpFactory.create(Root, { requestLogging: false });
  const url = await app.listen(0);

  const live = await fetch(`${url}health/live`);
  const ready = await fetch(`${url}health/ready`);
  expect(live.status).toBe(200);
  expect(ready.status).toBe(200);
  expect(((await ready.json()) as { status: string }).status).toBe('up');

  // Not awaited: the drain window is what this test is about.
  const shuttingDown = app.shutdown();
  await Bun.sleep(80);

  // Still listening, and now declining traffic.
  const draining = await fetch(`${url}health/ready`);
  expect(draining.status).toBe(503);
  const body = (await draining.json()) as {
    status: string;
    draining: boolean;
    checks: readonly { name: string; detail?: string }[];
  };
  expect(body.status).toBe('down');
  expect(body.draining).toBe(true);
  expect(body.checks[0]?.name).toBe('readiness');

  // And liveness still passes, so nothing decides to restart the pod mid-drain.
  expect((await fetch(`${url}health/live`)).status).toBe(200);

  await shuttingDown;

  // The socket is gone once the drain finished. A pooled keep-alive connection can
  // outlive `stop()`, so this opens a fresh one rather than reusing fetch's.
  const refused = await Bun.connect({
    hostname: new URL(url).hostname,
    port: Number(new URL(url).port),
    socket: { data: () => undefined },
  }).then(
    (socket) => {
      socket.end();
      return false;
    },
    () => true,
  );
  expect(refused).toBe(true);
});

test('routes: false binds the registry and mounts nothing', async () => {
  @Module({ imports: [HealthModule.forRoot({ routes: false })] })
  class Root {}

  const app = await HttpFactory.create(Root, { requestLogging: false });
  const url = await app.listen(0);

  expect((await fetch(`${url}health/live`)).status).toBe(404);

  await app.shutdown();
});

test('documented: false still serves both probes', async () => {
  @Module({
    imports: [
      HealthModule.forRoot({ readiness: [new Db()], documented: false }),
    ],
  })
  class Root {}

  const app = await HttpFactory.create(Root, { requestLogging: false });
  const url = await app.listen(0);

  // The subclass carries `@ApiHidden()` and inherits the prefix and both
  // handlers, so what is served is identical - only the document changes.
  expect((await fetch(`${url}health/live`)).status).toBe(200);
  expect((await fetch(`${url}health/ready`)).status).toBe(200);

  await app.shutdown();
});
