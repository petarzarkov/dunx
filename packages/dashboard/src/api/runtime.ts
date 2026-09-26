import { RuntimeStats } from '@dunx/core';
import { boundedProbe } from '@dunx/http/internal';
import type { DashboardProbe, ProbeResult } from '../contracts.js';
import type { DashboardOptions } from '../options.js';
import type { ProbeReport, RuntimeReport } from './types.js';

export const runProbe = async (
  probe: DashboardProbe,
  timeoutMs: number,
): Promise<ProbeReport> => {
  const started = performance.now();
  const result = await boundedProbe(() => probe.check(), timeoutMs);
  return {
    name: probe.name,
    state: result.state,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
    ...(result.data === undefined ? {} : { data: result.data }),
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
    const roundTripMs = Math.round(performance.now() - started);
    return {
      state: 'up',
      detail: `PING ${roundTripMs}ms`,
      data: { roundTripMs },
    };
  },
});

export const runtimeReport = async (
  options: DashboardOptions,
  startedAt: number,
): Promise<RuntimeReport> => {
  const probes = [
    ...(options.redis ? [redisProbe(options.redis)] : []),
    ...options.probes,
  ];

  // `RuntimeStats` owns every process reader now that the health module wants
  // the same ones. `uptimeMs` still counts from when the middleware was
  // constructed rather than from `process.uptime()`, which counts from the
  // interpreter starting - a difference that matters in a process that spent
  // thirty seconds running migrations before it served.
  const { now: _iso, ...process_ } = new RuntimeStats(startedAt).snapshot();

  return {
    ...process_,
    // Concurrent, and each already bounded, so the endpoint costs the slowest
    // probe rather than their sum.
    probes: await Promise.all(
      probes.map((probe) => runProbe(probe, options.probeTimeoutMs)),
    ),
    now: Date.now(),
  };
};
