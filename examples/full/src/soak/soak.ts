import { Logger } from '@dunx/core';
import {
  HealthRegistry,
  PubSub,
  RequestMetrics,
  type HttpApp,
} from '@dunx/http';
import { Lobby } from '../chat/lobby.service.js';
import { createApp } from '../main.js';
import { LoadBudget } from './budget.js';
import { Sampler } from './sampler.js';
import { Workload } from './workload.js';

/**
 * Raised so the app rather than the rate limiter is what this measures.
 * `ConfigModule` holds a live reference to `Bun.env` and reads it when
 * `createApp()` runs, so setting it here reaches the app that boots below.
 * See docs/architecture/tooling.md, "The load run measured the rate limiter".
 */
Bun.env['THROTTLE_LIMIT'] ??= '100000';

/**
 * A long-running process under sustained mixed load, watched for the things a
 * request-per-test suite cannot see: memory that never comes back, an event loop
 * that stalls, per-connection state that outlives the connection, and a route
 * whose p99 moved.
 *
 * `bun run soak` for the default 30 seconds, `bun run soak -- --seconds 600` for
 * a real one. CI runs 40 seconds at concurrency 12.
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
 * Over the per-round settled readings, not the in-flight series. 2 MiB/min is
 * about 3 GiB a day. See docs/architecture/tooling.md, "The leak verdict".
 */
const SETTLED_HEAP_LIMIT_PER_MIN = 2 * MB;
/** RSS is reported rather than judged, for the reason above. */
const MAX_LAG_MS = 750;
/** Below this the settled series is noise, so the run reports without judging. */
const MIN_VERDICT_MINUTES = 3;
/** One settled reading's GC noise, measured across runs at about +/-2.5 MiB. */
const NOISE_FLOOR = 5 * MB;
/** The stress burst, as a multiple of the steady concurrency. */
const STRESS_FACTOR = 4;
/** Shutdown has this long once traffic is in flight, and no longer. */
const SHUTDOWN_BUDGET_MS = 10_000;

export class Soak {
  constructor(private readonly options: SoakOptions) {}

  async run(): Promise<SoakVerdict> {
    const app = await createApp();
    const url = await app.listen(0);
    const logger = app.get(Logger);
    const pubsub = app.get(PubSub);
    const failures: string[] = [];
    const report: string[] = [];

    const redisUp = await Soak.#redisUp(app);
    report.push(
      redisUp
        ? 'redis is up: the cache and queue ops are held to the work floor'
        : 'redis is down: the cache and queue ops report but are not floored',
    );

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
        `${(totals.calls / elapsed).toFixed(0)}/s`,
    );
    report.push(...workload.rows());

    const budget = new LoadBudget();
    const verdict = budget.check({
      stats: workload.stats,
      elapsedSeconds: elapsed,
      metrics: app.get(RequestMetrics).snapshot(),
      redisUp,
    });
    report.push(...verdict.report);
    failures.push(...verdict.failures);

    Soak.#reportSampler(sampler, elapsed, settled, report, failures);
    Soak.#reportLeak(settledPoints, elapsed, report, failures);

    // Every socket the steady phase opened has closed by now, cleanly or not.
    await Bun.sleep(250);
    const after = pubsub.subscriberCount(Lobby.TOPIC);
    report.push(`chat subscribers: ${before} before, ${after} after`);
    if (after > before) {
      failures.push(
        `${after - before} chat subscriber(s) outlived their sockets (was ${before})`,
      );
    }

    await this.#stress(url, redisUp, report, failures);
    await this.#shutdownUnderLoad(app, url, report, failures);
    return { ok: failures.length === 0, failures, calls: totals.calls, report };
  }

  /**
   * A burst at {@link STRESS_FACTOR} times the steady concurrency, then a
   * recovery round back at it. No work floor on the burst: being refused under
   * stress is correct. What must hold is that nothing fails at the transport, no
   * route answers a status it never answers idle, and the app comes back.
   */
  async #stress(
    url: string,
    redisUp: boolean,
    report: string[],
    failures: string[],
  ): Promise<void> {
    const concurrency = this.options.concurrency * STRESS_FACTOR;
    const burst = new Workload(url);
    const startedAt = Date.now();
    await burst.run(Date.now() + 5000, concurrency);
    const elapsed = (Date.now() - startedAt) / 1000;
    const totals = burst.totals();
    report.push(
      `stress: ${totals.calls} calls at concurrency ${concurrency} in ${elapsed.toFixed(1)}s, ` +
        `${totals.worked} worked, ${totals.refused} refused, ${totals.bad} bad`,
    );
    for (const [name, s] of burst.stats) {
      if (s.errors > 0) {
        failures.push(
          `stress ${name}: ${s.errors}/${s.calls} failed at the transport, last: ${s.lastDetail}`,
        );
      }
      if (s.unexpected.size > 0) {
        const seen = [...s.unexpected]
          .map(([status, n]) => `${status} x${n}`)
          .join(', ');
        failures.push(`stress ${name}: answered ${seen} under load`);
      }
    }

    // Recovery: the same traffic at the steady rate has to meet the floor again.
    const after = new Workload(url);
    const recoveryStarted = Date.now();
    await after.run(Date.now() + 4000, this.options.concurrency);
    const recovery = new LoadBudget().check({
      stats: after.stats,
      elapsedSeconds: (Date.now() - recoveryStarted) / 1000,
      redisUp,
    });
    report.push(
      `recovery after stress: ${after.totals().worked} calls did work`,
    );
    failures.push(...recovery.failures.map((f) => `after stress, ${f}`));
  }

  /**
   * Shutdown with traffic **in flight**. The traffic is its own `Workload` and
   * its errors are not judged: once the port closes, an in-flight request
   * failing is the point. What is judged is that `shutdown()` finishes inside
   * its budget and that the traffic settles rather than hanging.
   */
  async #shutdownUnderLoad(
    app: HttpApp,
    url: string,
    report: string[],
    failures: string[],
  ): Promise<void> {
    const traffic = new Workload(url);
    const running = traffic.run(Date.now() + 8000, this.options.concurrency);
    // Long enough for every worker to have a request on the wire.
    await Bun.sleep(500);
    const inFlight = traffic.totals().calls;

    const started = performance.now();
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
      // The loser of the race is still a live timer, and leaving it pending held
      // the process open for 15 seconds after a clean shutdown.
      if (handle !== undefined) clearTimeout(handle);
    }
    // Anything still looping is now retrying a refused connection.
    traffic.stop();
    const ms = performance.now() - started;
    // On the timeout path too: `stop()` ends a worker's loop but not the call
    // inside it, so returning before this leaves fetches outstanding.
    const settled = await Soak.#settle(running);
    if (settled === 'hung') {
      failures.push(
        'traffic in flight at shutdown never settled: a socket was left open',
      );
    }
    if (outcome === 'timeout') {
      failures.push(
        'shutdown did not finish within 15s with traffic in flight',
      );
      return;
    }
    report.push(
      `shutdown took ${ms.toFixed(0)}ms with ${inFlight} calls already made and workers still calling`,
    );
    if (ms > SHUTDOWN_BUDGET_MS) {
      failures.push(
        `shutdown took ${ms.toFixed(0)}ms under load, over the ${SHUTDOWN_BUDGET_MS}ms budget`,
      );
    }
    if (settled === 'settled') {
      const totals = traffic.totals();
      report.push(
        `traffic at shutdown settled: ${totals.calls} calls, ${totals.worked} worked before the port closed`,
      );
    }
  }

  /**
   * The bounded wait for traffic to stop. The timer is cleared either way:
   * `Bun.sleep` cannot be, and the loser of the race held the process open.
   */
  static #settle(running: Promise<void>): Promise<'settled' | 'hung'> {
    let handle: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      running.then(() => 'settled' as const),
      new Promise<'hung'>((resolve) => {
        handle = setTimeout(() => resolve('hung'), 15_000);
      }),
    ]).finally(() => {
      if (handle !== undefined) clearTimeout(handle);
    });
  }

  static #reportSampler(
    sampler: Sampler,
    elapsed: number,
    settled: ReturnType<typeof process.memoryUsage>,
    report: string[],
    failures: string[],
  ): void {
    report.push(
      `cpu ${sampler.cpuMs().toFixed(0)}ms over ${elapsed.toFixed(1)}s ` +
        `(${((sampler.cpuMs() / (elapsed * 1000)) * 100).toFixed(0)}% of one core), ` +
        `max loop stall ${sampler.maxLagMs().toFixed(0)}ms`,
    );
    report.push(
      `settled heap ${(settled.heapUsed / MB).toFixed(1)} MiB, rss ${(settled.rss / MB).toFixed(1)} MiB`,
    );
    if (sampler.maxLagMs() > MAX_LAG_MS) {
      failures.push(
        `event loop stalled for ${sampler.maxLagMs().toFixed(0)}ms`,
      );
    }
  }

  static #reportLeak(
    settledPoints: readonly (readonly [number, number])[],
    elapsed: number,
    report: string[],
    failures: string[],
  ): void {
    const growth = Soak.settledSlope(settledPoints);
    const rise =
      (settledPoints[settledPoints.length - 1]?.[1] ?? 0) -
      (settledPoints[0]?.[1] ?? 0);
    const minutes = elapsed / 60;
    // Both the slope and the raw rise must clear the noise floor, and a window
    // too short to resolve 2 MiB/min says so rather than guessing.
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

  /** The app's own answer, so the run and the readiness probe cannot disagree. */
  static async #redisUp(app: HttpApp): Promise<boolean> {
    const { checks } = await app.get(HealthRegistry).readiness();
    return checks.some(
      (check) => check.name.includes('redis') && check.state === 'up',
    );
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
