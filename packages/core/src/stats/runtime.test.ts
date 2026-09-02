import { describe, expect, it } from 'bun:test';
import { RuntimeStats } from './runtime.js';

describe('RuntimeStats', () => {
  it('reports the process, with memory in bytes and cpu in microseconds', () => {
    const report = new RuntimeStats().snapshot();

    expect(report.pid).toBe(process.pid);
    expect(report.bun).toBe(Bun.version);
    expect(report.platform).toBe(process.platform);
    expect(report.arch).toBe(process.arch);
    expect(report.memory.rss).toBeGreaterThan(0);
    expect(report.memory.heapUsed).toBeGreaterThan(0);
    // Not `heapTotal >= heapUsed`: JSC reports the two from different
    // accountings and `heapUsed` is routinely the larger of them (7.1 MB against
    // 9.6 MB was one observed pair). Both are reported as Bun gives them.
    expect(report.memory.heapTotal).toBeGreaterThan(0);
    expect(report.cpu.user).toBeGreaterThan(0);
    expect(report.resource.maxRSS).toBeGreaterThan(0);
    expect(Date.parse(report.now)).toBeGreaterThan(0);
  });

  it('counts uptime from construction, not from interpreter start', async () => {
    // `process.uptime()` would already be seconds old here. This is the number a
    // service wants after a slow boot.
    const stats = new RuntimeStats();
    expect(stats.snapshot().uptimeMs).toBeLessThan(50);
    await Bun.sleep(30);
    expect(stats.snapshot().uptimeMs).toBeGreaterThanOrEqual(25);
  });

  it('accepts a boot mark taken before it was constructed', () => {
    const stats = new RuntimeStats(performance.now() - 5_000);
    expect(stats.snapshot().uptimeMs).toBeGreaterThanOrEqual(5_000);
  });

  it('serialises, which is what the dashboard and a scrape both need', () => {
    const report = new RuntimeStats().snapshot();
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
