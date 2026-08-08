import type { DashboardProbe, ProbeResult } from '../contracts.js';
import type { DashboardOptions } from '../options.js';
import { bounded } from './bounded.js';
import type { ProbeReport, RuntimeReport } from './types.js';

/**
 * `unknown` on a timeout, **not** `down`. A probe that did not answer in two
 * seconds has told us nothing about the service, and saying `down` would send
 * somebody to restart something healthy. A probe that *threw* did tell us
 * something, so that one is `down`.
 */
const withTimeout = (probe: DashboardProbe, ms: number): Promise<ProbeResult> =>
  bounded(
    async () => {
      try {
        return await probe.check();
      } catch (error) {
        return {
          state: 'down',
          detail: error instanceof Error ? error.message : String(error),
        } as const;
      }
    },
    ms,
    () => ({ state: 'unknown', detail: `no answer in ${ms}ms` }),
  );

export const runProbe = async (
  probe: DashboardProbe,
  timeoutMs: number,
): Promise<ProbeReport> => {
  const started = performance.now();
  const result = await withTimeout(probe, timeoutMs);
  return {
    name: probe.name,
    state: result.state,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
    ms: Math.round(performance.now() - started),
  };
};

/**
 * The Redis handle, if the app passed one, as a probe like any other - so the
 * lights row has one shape and the panel does not special-case its own dependency.
 *
 * `ping` rather than `connected`: the flag says whether a socket is up, and a
 * round trip says whether the server is answering, which is the question.
 */
export const redisProbe = (
  redis: NonNullable<DashboardOptions['redis']>,
): DashboardProbe => ({
  name: 'redis',
  check: async (): Promise<ProbeResult> => {
    const started = performance.now();
    await redis.ping();
    return {
      state: 'up',
      detail: `PING ${Math.round(performance.now() - started)}ms`,
    };
  },
});

const memory = (): RuntimeReport['memory'] => {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
  };
};

export const runtimeReport = async (
  options: DashboardOptions,
  startedAt: number,
): Promise<RuntimeReport> => {
  const probes = [
    ...(options.redis ? [redisProbe(options.redis)] : []),
    ...options.probes,
  ];

  return {
    pid: process.pid,
    // From when the middleware was constructed rather than `process.uptime()`,
    // which counts from the interpreter starting - a difference that matters in a
    // process that spent thirty seconds running migrations before it served.
    uptimeMs: Math.round(performance.now() - startedAt),
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    memory: memory(),
    // Concurrent, and each already bounded, so the endpoint costs the slowest
    // probe rather than their sum.
    probes: await Promise.all(
      probes.map((probe) => runProbe(probe, options.probeTimeoutMs)),
    ),
    now: Date.now(),
  };
};
