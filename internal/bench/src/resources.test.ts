import { describe, expect, it } from 'bun:test';
import { procIsReadable, readTree, ResourceSampler } from './resources.js';

const linux = process.platform === 'linux';

describe('readTree', () => {
  it.skipIf(!linux)(
    'reads this process, which is the one it can be sure of',
    () => {
      const snapshot = readTree(process.pid);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.processes).toBeGreaterThanOrEqual(1);
      // A Bun process holding a test runner is never under a megabyte.
      expect(snapshot?.rssBytes ?? 0).toBeGreaterThan(1024 * 1024);
      expect(snapshot?.cpuMs ?? -1).toBeGreaterThanOrEqual(0);
    },
  );

  it('answers null for a pid that is not there, rather than throwing', () => {
    // A subject may exit between the walk and the read, and a sample missing a
    // short-lived child has to be better than an exception.
    expect(readTree(0x7fff_fffe)).toBeNull();
  });

  it.skipIf(!linux)(
    'sums a child into its parent, which is what gunicorn needs',
    async () => {
      const child = Bun.spawn(['sleep', '3'], { stdout: 'ignore' });
      try {
        const snapshot = readTree(process.pid);
        expect(snapshot?.processes ?? 0).toBeGreaterThanOrEqual(2);
      } finally {
        child.kill('SIGKILL');
        await child.exited;
      }
    },
  );
});

describe('ResourceSampler', () => {
  it.skipIf(!linux)('reports a window it actually sampled', async () => {
    const sampler = new ResourceSampler(process.pid);
    sampler.start();
    const until = performance.now() + 250;
    // Busy, so there is CPU to find. Sleeping would measure nothing.
    while (performance.now() < until) JSON.parse('{"a":1}');
    await Bun.sleep(60);
    const sample = sampler.stop();

    expect(sample).not.toBeNull();
    expect(sample?.readings ?? 0).toBeGreaterThan(1);
    expect(sample?.elapsedMs ?? 0).toBeGreaterThan(200);
    expect(sample?.cpuMs ?? -1).toBeGreaterThan(0);
    expect(sample?.rssPeakBytes ?? 0).toBeGreaterThanOrEqual(
      sample?.rssMeanBytes ?? 0,
    );
  });

  it('reports null for a pid it never read, so the report carries no zeroes', () => {
    const sampler = new ResourceSampler(0x7fff_fffe);
    sampler.start();
    expect(sampler.stop()).toBeNull();
  });
});

describe('procIsReadable', () => {
  it('agrees with the platform', () => {
    expect(procIsReadable()).toBe(linux);
  });
});
