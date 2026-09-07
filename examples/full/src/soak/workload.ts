import { OpClient } from './client.js';
import { OPS, type Op } from './ops.js';

export interface OpStats {
  calls: number;
  /** Answered with a status the op called work. */
  worked: number;
  /** Answered with a legitimate refusal: a rate limit, or a degraded route. */
  refused: number;
  /** Answered with a status the op named neither, keyed by status. */
  readonly unexpected: Map<number, number>;
  /** The transport failed: a timeout, a reset, a socket that never opened. */
  errors: number;
  totalMs: number;
  maxMs: number;
  lastDetail: string | undefined;
}

const emptyStats = (): OpStats => ({
  calls: 0,
  worked: 0,
  refused: 0,
  unexpected: new Map(),
  errors: 0,
  totalMs: 0,
  maxMs: 0,
  lastDetail: undefined,
});

/**
 * Drives `OPS` at a fixed concurrency and records what each one answered.
 *
 * Every worker is its own {@link OpClient} with its own api key, so the rate
 * limiter counts them apart. Sharing one subject made the limiter the bottleneck
 * and the run measured refusals rather than the app.
 */
export class Workload {
  readonly stats = new Map<string, OpStats>();
  readonly #picker: readonly Op[];
  #stopped = false;

  constructor(private readonly base: string) {
    for (const op of OPS) this.stats.set(op.name, emptyStats());
    // Expand the weights once so a pick is one array index rather than a scan.
    this.#picker = OPS.flatMap((op) => Array<Op>(op.weight).fill(op));
  }

  /**
   * Asks every worker to finish its current call and leave.
   *
   * The shutdown phase needs this: once the port has closed, workers left running
   * to their deadline retry a refused connection as fast as the loop allows, and
   * one 8-second window logged 189,803 of them.
   */
  stop(): void {
    this.#stopped = true;
  }

  /** Runs `concurrency` workers until `deadline`, resolving when all have stopped. */
  async run(deadline: number, concurrency: number): Promise<void> {
    const worker = async (id: number): Promise<void> => {
      const client = new OpClient(this.base, `soak-vu-${id}`);
      while (!this.#stopped && Date.now() < deadline) {
        const op =
          this.#picker[Math.floor(Math.random() * this.#picker.length)];
        if (op === undefined) return;
        await this.#once(op, client);
      }
    };
    await Promise.all(
      Array.from({ length: concurrency }, (_, id) => worker(id)),
    );
  }

  async #once(op: Op, client: OpClient): Promise<void> {
    const entry = this.stats.get(op.name);
    if (entry === undefined) return;
    const started = performance.now();
    entry.calls++;
    try {
      const status = await op.run(client);
      if (op.expect.has(status)) entry.worked++;
      else if (op.tolerate.has(status)) entry.refused++;
      else {
        entry.unexpected.set(status, (entry.unexpected.get(status) ?? 0) + 1);
        entry.lastDetail = `unexpected ${status}`;
      }
    } catch (error) {
      entry.errors++;
      entry.lastDetail = error instanceof Error ? error.message : String(error);
    }
    const ms = performance.now() - started;
    entry.totalMs += ms;
    entry.maxMs = Math.max(entry.maxMs, ms);
  }

  totals(): { calls: number; worked: number; refused: number; bad: number } {
    let calls = 0;
    let worked = 0;
    let refused = 0;
    let bad = 0;
    for (const s of this.stats.values()) {
      calls += s.calls;
      worked += s.worked;
      refused += s.refused;
      bad += s.errors;
      for (const n of s.unexpected.values()) bad += n;
    }
    return { calls, worked, refused, bad };
  }

  rows(): readonly string[] {
    return [...this.stats.entries()]
      .filter(([, s]) => s.calls > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, s]) => {
        const mean = s.totalMs / s.calls;
        const refused = s.refused > 0 ? `  refused ${s.refused}` : '';
        const unexpected =
          s.unexpected.size === 0
            ? ''
            : `  UNEXPECTED ${[...s.unexpected]
                .map(([status, n]) => `${status}x${n}`)
                .join(' ')}`;
        const errored = s.errors > 0 ? `  ERRORS ${s.errors}` : '';
        const why =
          s.lastDetail === undefined ||
          (s.errors === 0 && s.unexpected.size === 0)
            ? ''
            : ` (${s.lastDetail})`;
        return (
          `${name.padEnd(17)} ${String(s.calls).padStart(6)} calls  ` +
          `${String(s.worked).padStart(6)} worked  mean ${mean.toFixed(2)}ms  ` +
          `max ${s.maxMs.toFixed(1)}ms${refused}${unexpected}${errored}${why}`
        );
      });
  }
}
