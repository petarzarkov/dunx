/**
 * The traffic the soak run puts through the app.
 *
 * Every operation names the statuses it accepts, because a soak that treats a
 * 429 or a 404 as a failure cannot exercise the rate limiter or the unmatched
 * path, and those are two of the four places that hold per-request state. An
 * unexpected status is recorded against the operation rather than thrown, so one
 * broken route does not end the run and hide everything behind it.
 */
export interface OpResult {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail?: string;
}

export interface OpStats {
  calls: number;
  failures: number;
  totalMs: number;
  maxMs: number;
  lastDetail: string | undefined;
}

interface Op {
  readonly name: string;
  /** Relative share of the traffic. */
  readonly weight: number;
  run(base: string): Promise<string>;
}

const okStatuses = (...codes: readonly number[]): ReadonlySet<number> =>
  new Set(codes);

/** A fetch that names the route in its failure, since `fetch` alone does not. */
const call = async (
  base: string,
  path: string,
  accept: ReadonlySet<number>,
  init?: RequestInit,
): Promise<string> => {
  const res = await fetch(new URL(path, base), init);
  // The body must be drained or the socket is held until GC.
  await res.arrayBuffer();
  if (!accept.has(res.status)) {
    throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status}`);
  }
  return String(res.status);
};

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * A websocket that opens, exchanges a frame and closes. Connection churn is the
 * leak-prone half of a gateway: a subscriber map that is added to on open and
 * only tidied on a clean close grows on every aborted connection.
 */
const socketChurn = async (base: string, abort: boolean): Promise<string> => {
  const url = new URL('chat', base).href.replace('http', 'ws');
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('socket never opened')),
      4000,
    );
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('socket errored'));
      },
      { once: true },
    );
  });
  if (abort) {
    // No close frame: the half that a clean-close-only cleanup path misses.
    socket.terminate?.();
    socket.close();
    return 'aborted';
  }
  socket.send(JSON.stringify({ event: 'say', data: 'soak' }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  socket.close();
  return 'closed';
};

const OPS: readonly Op[] = [
  {
    name: 'notes.list',
    weight: 8,
    run: (b) => call(b, 'api/notes', okStatuses(200, 429)),
  },
  {
    name: 'notes.create',
    weight: 4,
    run: (b) =>
      call(b, 'api/notes', okStatuses(201, 429), json({ text: 'soak note' })),
  },
  {
    name: 'users.list',
    weight: 6,
    run: (b) => call(b, 'api/users?limit=5', okStatuses(200, 429)),
  },
  {
    name: 'users.one',
    weight: 4,
    run: (b) => call(b, 'api/users/1', okStatuses(200, 404, 429)),
  },
  {
    name: 'ledger.write',
    weight: 5,
    run: (b) =>
      call(
        b,
        'api/ledger',
        okStatuses(201, 429, 503),
        json({ account: 'soak', amount: 1, memo: 'soak' }),
      ),
  },
  {
    name: 'ledger.page',
    weight: 4,
    run: (b) => call(b, 'api/ledger/page?take=5', okStatuses(200, 429, 503)),
  },
  {
    name: 'cache.rw',
    weight: 4,
    run: async (b) => {
      const key = `soak-${Math.floor(Math.random() * 64)}`;
      await call(b, `api/cache/${key}`, okStatuses(200, 204, 429, 503), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { soak: true }, ttl: 60 }),
      });
      return call(b, `api/cache/${key}`, okStatuses(200, 404, 429, 503));
    },
  },
  {
    name: 'trace',
    weight: 3,
    run: (b) =>
      call(b, 'api/trace', okStatuses(200, 429), {
        headers: {
          traceparent:
            '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
      }),
  },
  {
    name: 'health.ready',
    weight: 2,
    run: (b) => call(b, 'api/health/ready', okStatuses(200, 503)),
  },
  {
    name: 'health.live',
    weight: 2,
    run: (b) => call(b, 'api/health/live', okStatuses(200, 503)),
  },
  {
    name: 'validation.400',
    weight: 3,
    run: (b) => call(b, 'api/notes', okStatuses(400, 429), json({ text: '' })),
  },
  {
    name: 'unmatched.404',
    weight: 3,
    run: (b) =>
      call(
        b,
        `api/nothing-here-${Math.random().toString(36).slice(2, 8)}`,
        okStatuses(404, 429),
      ),
  },
  {
    name: 'throttle.burst',
    weight: 4,
    run: (b) => call(b, 'api/limits/burst', okStatuses(200, 429)),
  },
  {
    name: 'openapi',
    weight: 1,
    run: (b) => call(b, 'api/openapi.json', okStatuses(200, 429)),
  },
  {
    name: 'ws.clean',
    weight: 3,
    run: (b) => socketChurn(b, false),
  },
  {
    name: 'ws.abort',
    weight: 3,
    run: (b) => socketChurn(b, true),
  },
];

export class Workload {
  readonly stats = new Map<string, OpStats>();
  #picker: readonly Op[] = [];

  constructor(private readonly base: string) {
    for (const op of OPS) {
      this.stats.set(op.name, {
        calls: 0,
        failures: 0,
        totalMs: 0,
        maxMs: 0,
        lastDetail: undefined,
      });
    }
    // Expand the weights once so a pick is one array index rather than a scan.
    this.#picker = OPS.flatMap((op) => Array<Op>(op.weight).fill(op));
  }

  /** Runs `concurrency` workers until `deadline`, resolving when all have stopped. */
  async run(deadline: number, concurrency: number): Promise<void> {
    const worker = async (): Promise<void> => {
      while (Date.now() < deadline) {
        const op =
          this.#picker[Math.floor(Math.random() * this.#picker.length)];
        if (op === undefined) return;
        await this.#once(op);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  async #once(op: Op): Promise<void> {
    const entry = this.stats.get(op.name);
    if (entry === undefined) return;
    const started = performance.now();
    try {
      await op.run(this.base);
      entry.calls++;
    } catch (error) {
      entry.calls++;
      entry.failures++;
      entry.lastDetail = error instanceof Error ? error.message : String(error);
    }
    const ms = performance.now() - started;
    entry.totalMs += ms;
    entry.maxMs = Math.max(entry.maxMs, ms);
  }

  totals(): { calls: number; failures: number } {
    let calls = 0;
    let failures = 0;
    for (const s of this.stats.values()) {
      calls += s.calls;
      failures += s.failures;
    }
    return { calls, failures };
  }

  rows(): readonly string[] {
    return [...this.stats.entries()]
      .filter(([, s]) => s.calls > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, s]) => {
        const mean = s.totalMs / s.calls;
        const failed = s.failures > 0 ? ` FAILED ${s.failures}` : '';
        const why = s.lastDetail === undefined ? '' : ` (${s.lastDetail})`;
        return (
          `${name.padEnd(16)} ${String(s.calls).padStart(6)} calls  ` +
          `mean ${mean.toFixed(2)}ms  max ${s.maxMs.toFixed(1)}ms${failed}${why}`
        );
      });
  }
}
