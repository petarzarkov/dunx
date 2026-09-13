import { describe, expect, test } from 'bun:test';
import {
  HealthIndicator,
  type ProbeResult,
  type StorageProbe,
} from './contracts.js';
import {
  DiskIndicator,
  DiskOptions,
  MemoryIndicator,
  MemoryOptions,
  StorageIndicator,
} from './indicators.js';
import { HealthOptions, HealthRegistry } from './registry.js';
import { Readiness, ReadinessOptions } from './readiness.js';

/**
 * `data` carries a check's own numbers, so a scrape reads values rather than the
 * sentence they were rendered into. `detail` is unchanged and still the one line
 * an operator reads.
 */
class QueueIndicator extends HealthIndicator {
  readonly name = 'queues';

  check(): ProbeResult {
    return {
      state: 'up',
      detail: 'notifications 12w/0a/500f',
      data: { waiting: 12, active: 0, failed: 500 },
    };
  }
}

class QuietIndicator extends HealthIndicator {
  readonly name = 'quiet';

  check(): ProbeResult {
    return { state: 'up' };
  }
}

class ThrowingIndicator extends HealthIndicator {
  readonly name = 'broken';

  check(): ProbeResult {
    throw new Error('no connection');
  }
}

const reportOf = (indicators: readonly HealthIndicator[]) =>
  new HealthRegistry(
    new HealthOptions({ readiness: indicators }),
    new Readiness(new ReadinessOptions()),
  ).report(indicators);

describe('ProbeResult.data', () => {
  test('reaches the report as the indicator gave it', async () => {
    const [check] = (await reportOf([new QueueIndicator()])).checks;

    expect(check?.data).toEqual({ waiting: 12, active: 0, failed: 500 });
    // Beside `detail`, not instead of it.
    expect(check?.detail).toBe('notifications 12w/0a/500f');
  });

  /** `exactOptionalPropertyTypes`: absent and explicitly undefined differ, and
   * the dashboard asserts a probe that gave none carries no key. */
  test('is absent entirely when the check gave none', async () => {
    const [check] = (await reportOf([new QuietIndicator()])).checks;

    expect(check).not.toHaveProperty('data');
  });

  test('is absent on a check that threw, which has a message and no numbers', async () => {
    const [check] = (await reportOf([new ThrowingIndicator()])).checks;

    expect(check?.state).toBe('down');
    expect(check?.detail).toBe('no connection');
    expect(check).not.toHaveProperty('data');
  });

  test('survives JSON, which is what a scrape actually reads', async () => {
    const report = await reportOf([new QueueIndicator()]);
    const parsed = JSON.parse(JSON.stringify(report)) as typeof report;

    expect(parsed.checks[0]?.data).toEqual({
      waiting: 12,
      active: 0,
      failed: 500,
    });
  });
});

/** The shipped indicators had real numbers and rendered them into a sentence. */
describe('the shipped indicators', () => {
  test('memory reports the bytes behind its sentence', async () => {
    const maxRssBytes = 2 ** 40;
    const [check] = (
      await reportOf([new MemoryIndicator(new MemoryOptions({ maxRssBytes }))])
    ).checks;

    expect(check?.data?.['maxRssBytes']).toBe(maxRssBytes);
    expect(check?.data?.['rssBytes']).toBeGreaterThan(0);
    expect(check?.detail).toContain('MiB');
  });

  test('disk reports total, free and the fraction it rounded', async () => {
    const [check] = (
      await reportOf([
        new DiskIndicator(new DiskOptions({ path: '.', maxUsedFraction: 1 })),
      ])
    ).checks;

    expect(check?.data?.['totalBytes']).toBeGreaterThan(0);
    expect(check?.data?.['usedFraction']).toBeLessThanOrEqual(1);
    expect(check?.data?.['freeBytes']).toBeGreaterThanOrEqual(0);
  });

  test('a round trip reports its latency as a number', async () => {
    const storage: StorageProbe = { exists: async () => true };
    const [check] = (await reportOf([new StorageIndicator(storage)])).checks;

    expect(typeof check?.data?.['roundTripMs']).toBe('number');
    expect(check?.detail).toBe(`${String(check?.data?.['roundTripMs'])} ms`);
  });
});
