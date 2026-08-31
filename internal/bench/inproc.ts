/**
 * One logger, one process: the request-logging path driven straight through
 * `RequestLoggingMiddleware.handle`, with no socket under it.
 *
 * `bun run logging` measures the same work through oha, which on a 20-thread
 * laptop carries a standard deviation near a microsecond, wider than everything
 * this compares. Everything below the socket is identical.
 *
 * Two traps this had to work around, both of which produced confident wrong
 * answers first:
 *
 * - A `for` loop of `await`s never lets the macrotask queue run, so the batched
 *   writer's flush never fires. Measured, 50,000 emits produced zero flushes and a
 *   10 MB pending rope, and every row was scored on how fast it grew a rope.
 * - Yielding with `setTimeout(resolve, 0)` swaps that for a different artifact:
 *   Bun clamps a zero timeout to about a millisecond, which put every row at 21 us
 *   of idle timer. `setImmediate` is the yield that measures the work.
 *
 * Several loggers in one process contaminate each other through the shared
 * `handle` and `info` call sites, measured here as a 1.8 us swing on identical
 * code between two orderings. `inproc-driver.ts` spawns one variant per process.
 *
 *   bun inproc.ts <variant>    ns/req on stderr, log lines discarded
 */
import {
  AsyncRequestContext,
  ConsoleLogger,
  type Logger,
  RequestContext,
  type RequestFields,
} from '@dunx/core';
import { AsyncLocalStorage } from 'node:async_hooks';
// Two builds of the same package, so a comparison between them is one driver run
// and round-robin rather than two runs whose spread is wider than the difference.
import { RequestLoggingMiddleware } from '@dunx/http';
import type { BunRequest } from 'bun';
import { isStep, StepMiddleware, type Step } from './steps.js';
import {
  DiscardLogger,
  SerializeOnlyLogger,
  TimestampLogger,
} from './servers/logging/variants.js';
import {
  AotLogger,
  AssembleLogger,
  LeanLogger,
  TrimLogger,
  RestOnlyLogger,
  ShortLogger,
  FastJsonLogger,
  MergeLogger,
  NoMergeLogger,
  TextLogger,
} from './servers/logging/formats.js';

const context = new AsyncRequestContext();

/**
 * `AsyncRequestContext` with both defensive copies removed, to price them.
 *
 * The shipped store copies the caller's fields on the way in (`{ ...context }`, so
 * an `updateContext` inside cannot leak back out) and copies the store again on the
 * way out (`getContext()`, so a reader cannot mutate it). The request-logging
 * middleware builds a fresh scope object per request and the logger only reads the
 * result, so for that one caller both copies are waste: three objects of the same
 * five keys per request where one would do.
 *
 * Removing them is a contract change rather than a tidy-up: a caller that reuses
 * the object it passed, or writes to the object it read, would be writing into the
 * live store. This row says whether that is worth arguing about.
 */
class DirectContext extends RequestContext {
  readonly #storage = new AsyncLocalStorage<RequestFields>();

  override getContext(): RequestFields {
    return this.#storage.getStore() ?? {};
  }

  override updateContext(fields: Partial<RequestFields>): void {
    const current = this.#storage.getStore();
    if (current) Object.assign(current, fields);
  }

  override runWithContext<T>(fields: RequestFields, callback: () => T): T {
    const enclosing = this.#storage.getStore();
    return this.#storage.run(
      enclosing === undefined ? fields : { ...enclosing, ...fields },
      callback,
    );
  }
}

const direct = new DirectContext();

const LOGGERS: Record<string, () => Logger> = {
  default: () => new ConsoleLogger(context),
  merge: () => new MergeLogger(context),
  text: () => new TextLogger(context),
  nomerge: () => new NoMergeLogger(context),
  fastjson: () => new FastJsonLogger(context),
  aot: () => new AotLogger(context),
  // The allocation lever: same logger, a store that copies nothing.
  lean: () => new LeanLogger(context),
  trim: () => new TrimLogger(context),
  direct: () => new ConsoleLogger(direct),
  // Both levers at once - no scope copies and no merged entry object.
  aotdirect: () => new AotLogger(direct),
  floor: () => new ConsoleLogger(context),
  // The `entry` step of the ladder, split by how far into the logger it goes.
  'entry-discard': () => new DiscardLogger(),
  'entry-stamp': () => new TimestampLogger(),
  'entry-rest': () => new RestOnlyLogger(),
  'entry-assemble': () => new AssembleLogger(context),
  'entry-short': () => new ShortLogger(context),
  'entry-lean': () => new LeanLogger(context),
  'entry-serialize': () => new SerializeOnlyLogger(context),
  'entry-write': () => new ConsoleLogger(context),
};

/** The `entry-*` rows all run the full step ladder and vary only the logger. */
const stepOf = (variant: string): Step | undefined => {
  if (isStep(variant)) return variant;
  return variant.startsWith('entry-') ? 'entry' : undefined;
};

const name = process.argv[2] ?? 'default';
const make = LOGGERS[name] ?? (() => new ConsoleLogger(context));
if (LOGGERS[name] === undefined && !isStep(name)) {
  throw new Error(
    `Unknown variant "${name}". One of: ${Object.keys(LOGGERS).join(', ')}`,
  );
}

const ctx = {
  controller: 'BenchController',
  handler: 'json',
  method: 'GET',
  path: '/json',
  parsesBody: false,
  get: () => undefined,
} as unknown as Parameters<RequestLoggingMiddleware['handle']>[1];

const AGENTS = ['oha/1.15.0', 'curl/8.5.0', 'Mozilla/5.0 (X11; Linux x86_64)'];
const PATHS = ['/json', '/plaintext', '/params/41', '/users', '/health'];

/**
 * Built once. Constructing a `Request` costs more than anything being compared and
 * costs the same in every row, so leaving it in the timed loop would dilute the
 * differences without changing their order.
 */
const POOL: BunRequest[] = [];
for (let i = 0; i < 512; i += 1) {
  POOL.push(
    new Request(`http://127.0.0.1:3000${PATHS[i % PATHS.length]}`, {
      headers: { 'user-agent': AGENTS[i % AGENTS.length]! },
    }) as unknown as BunRequest,
  );
}

const next = (): Promise<Response> =>
  Promise.resolve(new Response('{"message":"Hello, World!"}'));

const store = name === 'direct' || name === 'aotdirect' ? direct : context;
const step = stepOf(name);
const mw: { handle: RequestLoggingMiddleware['handle'] } =
  step === undefined
    ? new RequestLoggingMiddleware(make(), store)
    : (new StepMiddleware(make(), context, step) as unknown as {
        handle: RequestLoggingMiddleware['handle'];
      });

const turn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/**
 * `floor` runs the loop with no middleware at all. Every other row is this plus
 * request logging, so `row - floor` is what logging costs and the ratio says how
 * much sensitivity the harness has left after the loop's own overhead.
 */
const FLOOR = name === 'floor';

const drive = async (iters: number, from: number): Promise<void> => {
  for (let i = 0; i < iters; i += 1) {
    if (FLOOR) await next();
    else await mw.handle(POOL[(from + i) % POOL.length]!, ctx, next);
    await turn();
  }
};

const ITERS = 60_000;
await drive(20_000, 0);
Bun.gc(true);

const runs: number[] = [];
for (let r = 0; r < 9; r += 1) {
  const t = Bun.nanoseconds();
  await drive(ITERS, r * ITERS);
  runs.push((Bun.nanoseconds() - t) / ITERS);
}
runs.sort((a, b) => a - b);
process.stderr.write(`${runs[4]!.toFixed(1)}\n`);
