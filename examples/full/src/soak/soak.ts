import { Logger } from '@dunx/core';
import { PubSub, type HttpApp } from '@dunx/http';
import { createApp } from '../main.js';
import { Lobby } from '../chat/lobby.service.js';
import { Sampler } from './sampler.js';
import { Workload } from './workload.js';

/**
 * A long-running process under sustained mixed load, watched for the things a
 * request-per-test suite cannot see: memory that never comes back, an event loop
 * that stalls, and per-connection state that outlives the connection.
 *
 * `bun run soak` for the default 30 seconds, `bun run soak -- --seconds 600` for
 * a real one. The bounded version in `soak.test.ts` is what CI runs.
 */
export interface SoakOptions {
  readonly seconds: number;
  readonly concurrency: number;
  /** Samples before this mark are dropped from the trend fit. */
  readonly warmupMs: number;
}

export interface SoakVerdict {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly calls: number;
  readonly report: readonly string[];
}

const MB = 1024 * 1024;

/**
 * The verdict comes from **settled** heap, not from the in-flight series.
 *
 * An in-flight slope measures the allocator as much as the program: RSS climbed
 * 11 MiB/min on a run whose `heapUsed` was falling and whose settled RSS came back
 * 20 MiB below its own peak, because an arena grows under load and is returned
 * lazily. So the run is split into rounds, each ending with a forced GC and a
 * quiet sample, and the fit is over those. A leak survives a GC; an arena does not.
 *
 * 2 MiB/min is roughly 3 GiB a day, which is a pod restarting on a memory limit
 * inside a week.
 */
const SETTLED_HEAP_LIMIT_PER_MIN = 2 * MB;
/** RSS is reported rather than judged, for the reason above. */
const MAX_LAG_MS = 750;
/** Below this the settled series is noise, so the run reports without judging. */
const MIN_VERDICT_MINUTES = 3;
/** One settled reading's GC noise, measured across runs at about +/-2.5 MiB. */
const NOISE_FLOOR = 5 * MB;

export class Soak {
  constructor(private readonly options: SoakOptions) {}

  async run(): Promise<SoakVerdict> {
    const app = await createApp();
    const url = await app.listen(0);
    const logger = app.get(Logger);
    const pubsub = app.get(PubSub);
    const failures: string[] = [];
    const report: string[] = [];

    const before = pubsub.subscriberCount(Lobby.TOPIC);
    const workload = new Workload(url);
    const sampler = new Sampler(250);

    logger.info(
      `soak: ${this.options.seconds}s at concurrency ${this.options.concurrency} against ${url}`,
    );
    sampler.start();
    const startedAt = Date.now();
    const rounds = Math.min(
      16,
      Math.max(4, Math.round(this.options.seconds / 30)),
    );
    const roundMs = (this.options.seconds * 1000) / rounds;
    /** One quiet reading per round: [minutes elapsed, settled heap bytes]. */
    const settledPoints: (readonly [number, number])[] = [];
    let settled = process.memoryUsage();

    for (let round = 0; round < rounds; round += 1) {
      await workload.run(Date.now() + roundMs, this.options.concurrency);
      // Let in-flight sockets close, then take the reading with the heap quiet.
      await Bun.sleep(200);
      Bun.gc(true);
      await Bun.sleep(200);
      settled = process.memoryUsage();
      settledPoints.push([(Date.now() - startedAt) / 60_000, settled.heapUsed]);
      report.push(
        `round ${round + 1}/${rounds} settled heap ${(settled.heapUsed / MB).toFixed(1)} MiB, ` +
          `rss ${(settled.rss / MB).toFixed(1)} MiB`,
      );
    }
    sampler.stop();

    const totals = workload.totals();
    const elapsed = (Date.now() - startedAt) / 1000;
    report.push(
      `${totals.calls} calls in ${elapsed.toFixed(1)}s, ` +
        `${(totals.calls / elapsed).toFixed(0)}/s, ${totals.failures} failed`,
    );
    report.push(...workload.rows());
    const trends = sampler.trends(this.options.warmupMs);
    report.push(...trends.map((trend) => Sampler.format(trend)));
    report.push(
      `cpu ${sampler.cpuMs().toFixed(0)}ms over ${elapsed.toFixed(1)}s ` +
        `(${((sampler.cpuMs() / (elapsed * 1000)) * 100).toFixed(0)}% of one core), ` +
        `max loop stall ${sampler.maxLagMs().toFixed(0)}ms`,
    );
    report.push(
      `settled heap ${(settled.heapUsed / MB).toFixed(1)} MiB, rss ${(settled.rss / MB).toFixed(1)} MiB`,
    );

    if (totals.failures > 0) {
      for (const [name, s] of workload.stats) {
        if (s.failures > 0) {
          failures.push(
            `${name}: ${s.failures}/${s.calls} failed, last: ${s.lastDetail}`,
          );
        }
      }
    }

    const growth = Soak.settledSlope(settledPoints);
    const rise =
      (settledPoints[settledPoints.length - 1]?.[1] ?? 0) -
      (settledPoints[0]?.[1] ?? 0);
    const minutes = elapsed / 60;
    /**
     * A settled reading carries about +/-2.5 MiB of GC noise, so a one-minute run
     * cannot resolve 2 MiB/min from nothing and saying otherwise would be a coin
     * toss dressed as a gate. Both the fitted slope and the raw first-to-last rise
     * have to clear the noise before this fails, and a window too short to judge
     * says so instead of guessing.
     */
    const judgeable =
      minutes >= MIN_VERDICT_MINUTES && settledPoints.length >= 4;
    report.push(
      `settled heap trend ${growth >= 0 ? '+' : ''}${(growth / MB).toFixed(2)} MiB/min, ` +
        `rise ${rise >= 0 ? '+' : ''}${(rise / MB).toFixed(1)} MiB over ${settledPoints.length} rounds` +
        (judgeable
          ? ' (the leak verdict)'
          : ` (window under ${MIN_VERDICT_MINUTES} min, reported not judged)`),
    );
    if (
      judgeable &&
      growth > SETTLED_HEAP_LIMIT_PER_MIN &&
      rise > NOISE_FLOOR
    ) {
      failures.push(
        `settled heap grew ${(growth / MB).toFixed(2)} MiB/min and rose ` +
          `${(rise / MB).toFixed(1)} MiB across ${settledPoints.length} rounds, ` +
          'which a forced GC did not reclaim',
      );
    }
    if (sampler.maxLagMs() > MAX_LAG_MS) {
      failures.push(
        `event loop stalled for ${sampler.maxLagMs().toFixed(0)}ms`,
      );
    }

    // Every socket the workload opened has closed by now, cleanly or not.
    await Bun.sleep(250);
    const after = pubsub.subscriberCount(Lobby.TOPIC);
    report.push(`chat subscribers: ${before} before, ${after} after`);
    if (after > before) {
      failures.push(
        `${after - before} chat subscriber(s) outlived their sockets (was ${before})`,
      );
    }

    await this.#shutdown(app, failures);
    return { ok: failures.length === 0, failures, calls: totals.calls, report };
  }

  /** Least squares over the per-round quiet readings, in bytes per minute. */
  static settledSlope(points: readonly (readonly [number, number])[]): number {
    if (points.length < 3) return 0;
    const n = points.length;
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
  }

  /** Shutdown is itself under test: it has to finish, and it has to be quiet. */
  async #shutdown(app: HttpApp, failures: string[]): Promise<void> {
    const started = performance.now();
    // The handle is kept and cleared: the loser of the race is still a live timer,
    // and leaving it pending held the process open for 15 seconds after a clean
    // shutdown, which is 15 seconds on every CI run.
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      handle = setTimeout(() => resolve('timeout'), 15_000);
    });
    let outcome: 'done' | 'timeout';
    try {
      outcome = await Promise.race([
        app.shutdown().then(() => 'done' as const),
        timeout,
      ]);
    } finally {
      if (handle !== undefined) clearTimeout(handle);
    }
    if (outcome === 'timeout') {
      failures.push('shutdown did not finish within 15s');
      return;
    }
    const ms = performance.now() - started;
    if (ms > 10_000) failures.push(`shutdown took ${ms.toFixed(0)}ms`);
  }
}

const parse = (argv: readonly string[]): SoakOptions => {
  const read = (flag: string, fallback: number): number => {
    const at = argv.indexOf(flag);
    if (at === -1) return fallback;
    const raw = Number(argv[at + 1]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };
  const seconds = read('--seconds', 30);
  return {
    seconds,
    concurrency: read('--concurrency', 24),
    // A tenth of the run, floored at a second, so a short run still drops boot.
    warmupMs: Math.max(1000, (seconds * 1000) / 10),
  };
};

if (import.meta.main) {
  const verdict = await new Soak(parse(Bun.argv)).run();
  for (const line of verdict.report) console.log(line);
  if (!verdict.ok) {
    console.log('');
    for (const line of verdict.failures) console.log(`FAIL ${line}`);
    process.exit(1);
  }
  console.log('\nno leak signal, no failures');
}
