export interface MemoryReport {
  readonly rss: number;
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly external: number;
}

/** Microseconds of CPU consumed since the process started. */
export interface CpuReport {
  readonly user: number;
  readonly system: number;
}

/**
 * The parts of `process.resourceUsage()` a service is read for. The other ten
 * fields it returns are ipc, signal and filesystem counters that Bun reports as
 * 0 on Linux.
 */
export interface ResourceReport {
  readonly maxRSS: number;
  readonly minorPageFault: number;
  readonly majorPageFault: number;
  readonly voluntaryContextSwitches: number;
  readonly involuntaryContextSwitches: number;
}

export interface RuntimeReport {
  readonly pid: number;
  /** Since this object was constructed, which is boot rather than interpreter start. */
  readonly uptimeMs: number;
  readonly now: string;
  readonly bun: string;
  readonly platform: string;
  readonly arch: string;
  readonly memory: MemoryReport;
  readonly cpu: CpuReport;
  readonly resource: ResourceReport;
}

/**
 * The process readers, in one place because three consumers wanted them: the
 * dashboard's runtime panel, the health module's memory indicator, and stats.
 *
 * `snapshot()` costs ~14 us, almost all of it `process.memoryUsage()` at 12.7 us
 * on Bun 1.4.0. That is a poll-time call and never a per-request one.
 *
 * `uptimeMs` counts from construction rather than `process.uptime()`, which
 * counts from interpreter start - a difference worth having after thirty seconds
 * of migrations.
 *
 * Rejected on a measurement, each: `bun:jsc.heapStats()` at 7,040 us,
 * `node:v8.getHeapStatistics()` at 1,076-7,606 us with V8 names for a heap Bun
 * does not have, and `Bun.generateHeapSnapshot()` at ~700 ms holding the loop.
 */
export class RuntimeStats {
  readonly #startedAt: number;

  constructor(startedAt: number = performance.now()) {
    this.#startedAt = startedAt;
  }

  snapshot(): RuntimeReport {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const resource = process.resourceUsage();
    return {
      pid: process.pid,
      uptimeMs: Math.round(performance.now() - this.#startedAt),
      now: new Date().toISOString(),
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
      },
      cpu: { user: cpu.user, system: cpu.system },
      resource: {
        maxRSS: resource.maxRSS,
        minorPageFault: resource.minorPageFault,
        majorPageFault: resource.majorPageFault,
        voluntaryContextSwitches: resource.voluntaryContextSwitches,
        involuntaryContextSwitches: resource.involuntaryContextSwitches,
      },
    };
  }
}
