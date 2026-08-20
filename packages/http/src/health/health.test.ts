import { describe, expect, test } from 'bun:test';
import { HealthIndicator, type ProbeResult } from './contracts.js';
import {
  DiskIndicator,
  DiskOptions,
  MemoryIndicator,
  MemoryOptions,
  RedisIndicator,
} from './indicators.js';
import { Readiness, ReadinessOptions } from './readiness.js';
import { HealthOptions, HealthRegistry } from './registry.js';

const indicator = (
  name: string,
  check: () => Promise<ProbeResult> | ProbeResult,
  critical = true,
): HealthIndicator => ({ name, critical, check }) as HealthIndicator;

const registry = (
  indicators: readonly HealthIndicator[],
  timeoutMs = 2000,
  readiness = new Readiness(new ReadinessOptions()),
) =>
  new HealthRegistry(
    new HealthOptions({
      liveness: indicators,
      readiness: indicators,
      timeoutMs,
    }),
    readiness,
  );

describe('the report', () => {
  test('is up when every critical check is', async () => {
    const report = await registry([
      indicator('a', () => ({ state: 'up' })),
      indicator('b', async () => ({ state: 'up', detail: '1 ms' })),
    ]).liveness();

    expect(report.status).toBe('up');
    expect(report.draining).toBe(false);
    expect(report.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(report.checks.map((check) => check.name)).toEqual(['a', 'b']);
    expect(report.checks[1]?.detail).toBe('1 ms');
  });

  /**
   * The uptime is a duration, so it comes off a monotonic clock. It used to come off
   * `Date.now()`, which meant any backwards adjustment of the wall clock - NTP, a
   * suspend and resume, a VM resyncing with its host - produced a negative uptime.
   * A probe was caught answering `uptimeMs: -242` under WSL2.
   */
  test('survives the wall clock stepping backwards', async () => {
    const health = registry([indicator('a', () => ({ state: 'up' }))]);
    const realNow = Date.now;
    Date.now = () => realNow() - 60_000;

    try {
      const report = await health.liveness();
      expect(report.uptimeMs).toBeGreaterThanOrEqual(0);
    } finally {
      Date.now = realNow;
    }
  });

  test('reports uptime as a whole number of milliseconds', async () => {
    const report = await registry([
      indicator('a', () => ({ state: 'up' })),
    ]).liveness();

    expect(Number.isInteger(report.uptimeMs)).toBe(true);
  });

  test('a throwing check is down, carrying its message', async () => {
    const report = await registry([
      indicator('boom', () => {
        throw new Error('connection refused');
      }),
    ]).liveness();

    expect(report.status).toBe('down');
    expect(report.checks[0]?.state).toBe('down');
    expect(report.checks[0]?.detail).toBe('connection refused');
  });

  /*
   * A probe that did not answer has told you nothing, which is not the same as
   * telling you it is broken. The dashboard had this rule first.
   */
  test('a check that outruns its budget is unknown, not down', async () => {
    const report = await registry(
      [
        indicator('slow', async () => {
          await Bun.sleep(200);
          return { state: 'up' as const };
        }),
      ],
      20,
    ).liveness();

    expect(report.checks[0]?.state).toBe('unknown');
    expect(report.checks[0]?.detail).toMatch(/no answer in 20 ms/);
    expect(report.status).toBe('unknown');
  });

  test('a non-critical failure reports without failing the status', async () => {
    const report = await registry([
      indicator('disk', () => ({ state: 'down', detail: '91% used' }), false),
      indicator('db', () => ({ state: 'up' })),
    ]).liveness();

    expect(report.status).toBe('up');
    expect(report.checks[0]?.state).toBe('down');
    expect(report.checks[0]?.critical).toBe(false);
  });

  test('runs the checks concurrently, not in sequence', async () => {
    const slow = () => async () => {
      await Bun.sleep(60);
      return { state: 'up' as const };
    };
    const started = Bun.nanoseconds();
    await registry([
      indicator('a', slow()),
      indicator('b', slow()),
      indicator('c', slow()),
    ]).liveness();

    // Three 60 ms checks. Sequential would be ~180 ms; the window is wide because
    // a loaded machine is not a stopwatch.
    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(150);
  });

  test('an empty indicator list is up rather than an error', async () => {
    const report = await registry([]).liveness();

    expect(report.status).toBe('up');
    expect(report.checks).toEqual([]);
  });
});

/*
 * The reason `OnBeforeShutdown` was added to `@dunx/core`. Readiness has to start failing
 * while the port is still open, and liveness must not, or an orchestrator reads a
 * draining pod as one that needs killing.
 */
describe('draining', () => {
  test('fails readiness and leaves liveness alone', async () => {
    const readiness = new Readiness(new ReadinessOptions());
    const health = registry(
      [indicator('db', () => ({ state: 'up' }))],
      2000,
      readiness,
    );

    expect((await health.readiness()).status).toBe('up');

    await readiness.onBeforeShutdown();

    const ready = await health.readiness();
    expect(ready.status).toBe('down');
    expect(ready.draining).toBe(true);
    expect(ready.checks[0]?.name).toBe('readiness');
    expect(ready.checks[0]?.detail).toBe('shutting down');
    // A pod shutting down does not need restarting.
    expect((await health.liveness()).status).toBe('up');
  });

  test('holds and releases for a migration, without shutting down', async () => {
    const readiness = new Readiness(new ReadinessOptions());
    const health = registry([], 2000, readiness);

    readiness.hold('migrating');
    const held = await health.readiness();
    expect(held.status).toBe('down');
    expect(held.checks[0]?.detail).toBe('migrating');

    readiness.release();
    expect((await health.readiness()).status).toBe('up');
  });

  test('waits out the drain delay before returning', async () => {
    const readiness = new Readiness(new ReadinessOptions({ drainDelayMs: 60 }));

    const started = Bun.nanoseconds();
    const draining = readiness.onBeforeShutdown();
    // Failing already, before the wait is over: that is the point of the window.
    expect(readiness.draining).toBe(true);
    await draining;

    expect((Bun.nanoseconds() - started) / 1e6).toBeGreaterThanOrEqual(50);
  });

  test('a released hold does not undo a shutdown', async () => {
    const readiness = new Readiness(new ReadinessOptions());

    await readiness.onBeforeShutdown();
    readiness.release();

    expect(readiness.draining).toBe(true);
  });
});

describe('the shipped indicators', () => {
  test('redis reports the round trip it measured', async () => {
    const result = await new RedisIndicator({
      ping: async () => 'PONG',
    }).check();

    expect(result.state).toBe('up');
    expect(result.detail).toMatch(/^\d+ ms$/);
  });

  test('memory compares rss against a ceiling, and is not critical', () => {
    const roomy = new MemoryIndicator(
      new MemoryOptions({ maxRssBytes: 64 * 1024 ** 3 }),
    );
    expect(roomy.critical).toBe(false);
    expect(roomy.check().state).toBe('up');

    const tight = new MemoryIndicator(new MemoryOptions({ maxRssBytes: 1 }));
    const result = tight.check();
    expect(result.state).toBe('down');
    expect(result.detail).toMatch(/MiB of 0 MiB/);
  });

  test('disk measures a real filesystem', async () => {
    const result = await new DiskIndicator(
      new DiskOptions({ path: process.cwd(), maxUsedFraction: 0.999 }),
    ).check();

    expect(result.state).toBe('up');
    expect(result.detail).toMatch(/^\d+% of \d+ MiB used$/);
  });

  test('a full disk is down, and still not critical', async () => {
    const indicatorUnder = new DiskIndicator(
      new DiskOptions({ path: process.cwd(), maxUsedFraction: 0 }),
    );

    expect(indicatorUnder.critical).toBe(false);
    expect((await indicatorUnder.check()).state).toBe('down');
  });

  test('an unreadable path is a down check rather than a throw', async () => {
    const report = await registry([
      new DiskIndicator(
        new DiskOptions({ path: '/nope/not/here', maxUsedFraction: 0.9 }),
      ),
    ]).liveness();

    expect(report.checks[0]?.state).toBe('down');
    // Not critical, so a bad path does not shed traffic either.
    expect(report.status).toBe('up');
  });
});
