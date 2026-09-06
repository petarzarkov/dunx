/**
 * Samples the process while the workload runs, and decides afterwards whether
 * anything grew that should not have.
 *
 * A leak does not show up as a big number, it shows up as a **slope**. RSS climbs
 * during warmup on any runtime and settles; what matters is whether the settled
 * window still trends upward once the allocator has stopped growing the heap. So
 * the verdict comes from a least-squares fit over the post-warmup samples rather
 * than from first-against-last, which any GC timing can flip either way.
 */
export interface Sample {
  readonly at: number;
  readonly rss: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly cpuMs: number;
  readonly lagMs: number;
}

export interface Trend {
  readonly name: string;
  /** Bytes (or ms) per second over the measured window. */
  readonly slope: number;
  readonly first: number;
  readonly last: number;
  readonly peak: number;
}

const MB = 1024 * 1024;

/** Least squares over (seconds, value), returning the per-second slope. */
const slopeOf = (points: readonly (readonly [number, number])[]): number => {
  const n = points.length;
  if (n < 3) return 0;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (const [x, y] of points) {
    sx += x;
    sy += y;
    sxy += x * y;
    sxx += x * x;
  }
  const divisor = n * sxx - sx * sx;
  return divisor === 0 ? 0 : (n * sxy - sx * sy) / divisor;
};

export class Sampler {
  readonly #samples: Sample[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastCpu = process.cpuUsage();
  #startedAt = 0;
  #expectedTick = 0;

  constructor(private readonly everyMs = 250) {}

  get samples(): readonly Sample[] {
    return this.#samples;
  }

  start(): void {
    this.#startedAt = Date.now();
    this.#expectedTick = this.#startedAt + this.everyMs;
    this.#lastCpu = process.cpuUsage();
    this.#timer = setInterval(() => this.#tick(), this.everyMs);
    // The sampler must not be the reason the process stays alive.
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #tick(): void {
    const now = Date.now();
    // Timer drift is the cheapest event-loop lag signal there is: the interval
    // fired late by exactly as much as the loop was blocked.
    const lagMs = Math.max(0, now - this.#expectedTick);
    this.#expectedTick = now + this.everyMs;

    const mem = process.memoryUsage();
    const cpu = process.cpuUsage(this.#lastCpu);
    this.#lastCpu = process.cpuUsage();
    this.#samples.push({
      at: now - this.#startedAt,
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      external: mem.external,
      cpuMs: (cpu.user + cpu.system) / 1000,
      lagMs,
    });
  }

  /**
   * Drops the first `warmupMs` of samples, then fits each series. A run shorter
   * than three post-warmup samples yields a zero slope rather than a guess.
   */
  trends(warmupMs: number): readonly Trend[] {
    const window = this.#samples.filter((s) => s.at >= warmupMs);
    if (window.length === 0) return [];
    const series: readonly (readonly [string, (s: Sample) => number])[] = [
      ['rss', (s) => s.rss],
      ['heapUsed', (s) => s.heapUsed],
      ['external', (s) => s.external],
      ['lagMs', (s) => s.lagMs],
    ];
    return series.map(([name, read]) => {
      const points = window.map(
        (s) => [s.at / 1000, read(s)] as readonly [number, number],
      );
      const values = points.map(([, y]) => y);
      return {
        name,
        slope: slopeOf(points),
        first: values[0] ?? 0,
        last: values[values.length - 1] ?? 0,
        peak: Math.max(...values),
      };
    });
  }

  /** Total CPU milliseconds burned across the whole run. */
  cpuMs(): number {
    return this.#samples.reduce((total, s) => total + s.cpuMs, 0);
  }

  /** The worst single event-loop stall observed. */
  maxLagMs(): number {
    return this.#samples.reduce((worst, s) => Math.max(worst, s.lagMs), 0);
  }

  static format(t: Trend): string {
    const unit = t.name === 'lagMs' ? '' : ' MiB';
    const scale = t.name === 'lagMs' ? 1 : MB;
    const digits = t.name === 'lagMs' ? 2 : 1;
    const per = t.name === 'lagMs' ? 'ms/s' : 'MiB/min';
    const perValue = t.name === 'lagMs' ? t.slope : (t.slope * 60) / MB;
    return (
      `${t.name.padEnd(9)} ${(t.first / scale).toFixed(digits)}${unit} -> ` +
      `${(t.last / scale).toFixed(digits)}${unit}, peak ${(t.peak / scale).toFixed(digits)}${unit}, ` +
      `slope ${perValue >= 0 ? '+' : ''}${perValue.toFixed(3)} ${per}`
    );
  }
}
