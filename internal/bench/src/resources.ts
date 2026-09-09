/**
 * What a subject costs while it is answering, read out of `/proc`.
 *
 * Throughput says how many requests a subject served; it says nothing about what
 * it spent doing it. Two subjects at the same req/s can differ by 4x in resident
 * memory, and a subject that blocks its worker on I/O burns less CPU per request
 * than one that spins. Both are visible here and neither is visible in a rate.
 *
 * **`/proc` rather than a package.** `pidusage` and friends shell out to `ps` on
 * every sample; the kernel already publishes the two files this needs. There is no
 * `Bun.*` API for another process's usage - `process.memoryUsage()` and
 * `process.cpuUsage()` are about the caller - so this is the low-level interface
 * and not a reimplementation of one.
 *
 * **Linux only, and it says so instead of guessing.** `sample()` returns `null`
 * where `/proc` is absent, and the report then carries no resource rows rather
 * than zeroes that read as measurements.
 *
 * Three things about the numbers, because each one changes how they read:
 *
 * - **The whole process tree is summed.** `gunicorn` is a master and a worker, and
 *   charging Django only the master's 12 MiB would be wrong by the size of the
 *   thing actually serving.
 * - **CPU is normalised per request, not reported as a percentage.** Every subject
 *   here is one thread under saturating load, so every percentage is near 100 and
 *   ranks nothing. `cpuMsPerKiloRequests` is what separates them, and it is the
 *   reciprocal of throughput only for a subject that is CPU-bound - which is
 *   exactly what makes it worth reporting for the ones that are not.
 * - **RSS is sampled, so the peak is the peak of the samples.** A garbage collector
 *   that runs between two reads is missed. 50 ms against a 5-second round is 100
 *   samples, which finds a steady state and will under-report a spike. Only the
 *   peak is kept: a mean was carried end to end for a while and no table, chart
 *   or report ever read it.
 */
import { readFileSync } from 'node:fs';

const CLOCK_TICKS_PER_SECOND = 100;
const PAGE_SIZE = 4096;

/** `/proc/<pid>/stat` after the `comm` field, which may itself hold spaces. */
const statFields = (raw: string): readonly string[] => {
  const close = raw.lastIndexOf(')');
  return raw.slice(close + 2).split(' ');
};

interface Snapshot {
  readonly rssBytes: number;
  readonly cpuMs: number;
  readonly processes: number;
}

/** Direct children, via the file the kernel already maintains for the purpose. */
const childrenOf = (pid: number): readonly number[] => {
  try {
    const raw = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8');
    return raw
      .trim()
      .split(/\s+/)
      .filter((entry) => entry.length > 0)
      .map(Number)
      .filter((child) => Number.isInteger(child));
  } catch {
    return [];
  }
};

/**
 * One reading of a whole process tree. A pid that disappears between the walk and
 * the read is skipped rather than throwing: a subject may fork and reap while this
 * is running, and a sample missing one short-lived child is better than a sample
 * that is an exception.
 */
export const readTree = (root: number): Snapshot | null => {
  const pending = [root];
  const seen = new Set<number>();
  let rssBytes = 0;
  let cpuTicks = 0;
  let processes = 0;

  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    let fields: readonly string[];
    try {
      fields = statFields(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch {
      continue;
    }
    // Indices are the documented field numbers minus three, `state` being the
    // first one left after the pid and the comm are sliced off.
    const utime = Number(fields[11] ?? 0);
    const stime = Number(fields[12] ?? 0);
    const rssPages = Number(fields[21] ?? 0);
    cpuTicks += utime + stime;
    rssBytes += rssPages * PAGE_SIZE;
    processes += 1;
    pending.push(...childrenOf(pid));
  }

  if (processes === 0) return null;
  return {
    rssBytes,
    cpuMs: (cpuTicks / CLOCK_TICKS_PER_SECOND) * 1000,
    processes,
  };
};

export const procIsReadable = (): boolean => readTree(process.pid) !== null;

/** What one measured window cost. `null` where `/proc` did not answer. */
export interface ResourceSample {
  readonly rssPeakBytes: number;
  /** CPU consumed by the whole tree during the window, user plus system. */
  readonly cpuMs: number;
  readonly elapsedMs: number;
  readonly readings: number;
  /** The largest tree seen, so a forking subject is visible as one. */
  readonly processes: number;
}

const SAMPLE_INTERVAL_MS = 50;

/**
 * A round's resource reading beside the load sample it belongs to, paired by
 * index and never by a median of the other rounds. A round the sampler could not
 * read is dropped from both sides rather than paired with the wrong one.
 *
 * Shared because `run.ts` and `drivers.ts` both do this over the same shape, and
 * a correctness fix to the pairing had to land in one of them and not the other.
 */
export interface PairedRound<L> {
  readonly sample: ResourceSample;
  readonly load: L;
}

export const pairRounds = <L>(
  usage: readonly (ResourceSample | null)[],
  load: readonly L[],
): PairedRound<L>[] =>
  usage
    .map((sample, index) => ({ sample, load: load[index] }))
    .filter(
      (one): one is PairedRound<L> =>
        one.sample !== null && one.load !== undefined,
    );

/**
 * Samples one subject's tree for as long as a measured run lasts.
 *
 * `setInterval` with a synchronous body on purpose: an async read would let two
 * samples overlap and interleave their `/proc` walks, and a `readFileSync` of a
 * kernel pseudo-file costs microseconds and never touches a disk.
 */
export class ResourceSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private opening: Snapshot | null = null;
  private latest: Snapshot | null = null;
  private peakBytes = 0;
  private readings = 0;
  private processes = 0;

  constructor(private readonly pid: number) {}

  start(): void {
    this.opening = readTree(this.pid);
    this.latest = this.opening;
    this.peakBytes = this.opening?.rssBytes ?? 0;
    this.readings = 0;
    this.processes = this.opening?.processes ?? 0;
    this.startedAt = performance.now();
    this.timer = setInterval(() => this.take(), SAMPLE_INTERVAL_MS);
  }

  private take(): void {
    const reading = readTree(this.pid);
    if (reading === null) return;
    this.latest = reading;
    this.peakBytes = Math.max(this.peakBytes, reading.rssBytes);
    this.readings += 1;
    this.processes = Math.max(this.processes, reading.processes);
  }

  stop(): ResourceSample | null {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.take();
    const elapsedMs = performance.now() - this.startedAt;
    if (this.opening === null || this.latest === null || this.readings === 0) {
      return null;
    }
    return {
      rssPeakBytes: this.peakBytes,
      // Clamped: a child that exits mid-window takes its ticks out of the tree,
      // which would otherwise read as negative CPU.
      cpuMs: Math.max(0, this.latest.cpuMs - this.opening.cpuMs),
      elapsedMs,
      readings: this.readings,
      processes: this.processes,
    };
  }
}
