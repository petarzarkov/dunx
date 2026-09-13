import { describe, expect, it } from 'bun:test';
import { Module, provide } from '@dunx/core';
import { HealthModule, Readiness, ReadinessOptions } from '@dunx/http';
import { createTestApp } from './app.js';
import { createTestServer } from './server.js';

/** Long enough that paying it would be unmistakable, and that Bun's own 5 s hook
 * timeout would fire on a suite of any size. */
const DRAIN_MS = 5_000;

@Module({ imports: [HealthModule.forRoot({ drainDelayMs: DRAIN_MS })] })
class AppHealthModule {}

const elapsed = async (close: () => Promise<unknown>): Promise<number> => {
  const started = performance.now();
  await close();
  return performance.now() - started;
};

/**
 * `Readiness` holds shutdown for `drainDelayMs` so a load balancer notices the
 * failing probe. A suite has no load balancer and closes one app per file, so the
 * production value would be paid per teardown - as an unnamed hook timeout
 * naming no line, which is what made it expensive to diagnose.
 */
describe('the shutdown drain under test', () => {
  it('is not paid by createTestApp', async () => {
    const app = await createTestApp({ modules: [AppHealthModule] });

    expect(await elapsed(() => app.shutdown())).toBeLessThan(DRAIN_MS / 2);
  });

  it('is not paid by createTestServer', async () => {
    const server = await createTestServer({
      modules: [AppHealthModule],
      middleware: [],
    });

    expect(await elapsed(() => server.close())).toBeLessThan(DRAIN_MS / 2);
  });

  /** Readiness still fails before the port closes; only the wait is gone. */
  it('still flips readiness, which is the half that is not a timer', async () => {
    const app = await createTestApp({ modules: [AppHealthModule] });
    const readiness = app.get(Readiness);
    expect(readiness.draining).toBe(false);

    await app.shutdown();

    expect(readiness.draining).toBe(true);
    expect(readiness.reason).toBe('shutting down');
  });

  /** The harness's own override goes first, so a suite testing the drain wins. */
  it('is paid again by a suite that asks for it back', async () => {
    const app = await createTestApp({
      modules: [AppHealthModule],
      overrides: [
        provide(ReadinessOptions, {
          useValue: new ReadinessOptions({ drainDelayMs: 60 }),
        }),
      ],
    });

    expect(await elapsed(() => app.shutdown())).toBeGreaterThanOrEqual(50);
  });

  /**
   * The override names a class no module in this graph binds. That is registered
   * lazily rather than rejected, so it is never constructed and the harness can
   * apply it to every app without knowing whether `HealthModule` is in the graph.
   */
  it('costs a graph with no HealthModule nothing', async () => {
    @Module({})
    class BareModule {}

    const app = await createTestApp({ modules: [BareModule] });

    expect(await elapsed(() => app.shutdown())).toBeLessThan(DRAIN_MS / 2);
  });
});
