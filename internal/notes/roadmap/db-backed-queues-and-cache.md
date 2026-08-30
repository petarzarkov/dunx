# Queues and cache on the database, with Redis optional

The target: Firecracker runs on SQLite alone and barely changes. A dunx consumer
picks `redis`, `sqlite` or `postgres` for its queue and gets a persistent cache on
the same store. `JobPublisher`, `QueueModule`, `@JobHandler`, the runner and the
relays all keep working on whichever it picked.

This file is the plan. Nothing below is built. Delete it when the phases are done
and the outcome is in `docs/architecture/queues.md`.

## Two things have to be settled before any code

### 1. Rule 1 says do not write this

CLAUDE.md: "Do not write a dunx ORM, a dunx validator, a dunx auth flow, or a dunx
job queue", and Rule 1 "outranks every other consideration in this file... the
conflict is worth raising rather than resolving quietly". So it is raised here.

What the landscape actually offers, measured in PR #21 rather than assumed:

| Backend  | Mature library      | State                                                                   |
| -------- | ------------------- | ----------------------------------------------------------------------- |
| Redis    | **bullmq**          | integrated, shipping                                                    |
| Postgres | **pg-boss** 12.28.1 | measured working over `Bun.SQL`: 10 ms a job, no `pg` connection opened |
| SQLite   | **none**            | no mature JS queue library targets it                                   |

The SQLite requirement cannot be met by integrating anything, because there is
nothing to integrate. Meeting it means writing a job queue. The question is not
whether, but how far it extends.

**A. Three engines.** bullmq for Redis, pg-boss for Postgres, dunx for SQLite.
Rule 1 honoured wherever a library exists. The cost is three job models: pg-boss's
differs from bullmq's, so an app's retry semantics, job ids and state names change
when it changes backend, and the dashboard renders two shapes.

**B. Two engines.** bullmq for Redis, one dunx SQL engine over drizzle for both
SQLite and Postgres. One SQL implementation, one set of semantics, one dashboard
panel, one dialect difference. Rule 1 broken for the SQL half, deliberately.

**C. One engine.** Drop bullmq. Rewrites years of Redis edge cases for no gain.

**Recommended: B.** What Rule 1 protects against is a half-built queue competing
with a mature one. For SQLite there is no mature one to compete with, so that half
is forced. Having written it, running the same SQL over Postgres costs a dialect
rather than a second integration, and it is the option where a consumer's SQLite
development database behaves like its Postgres production one. A is the more
faithful reading of Rule 1 and its cost lands on consumers rather than on dunx.

Whichever is chosen, it belongs in CLAUDE.md as a recorded exception, not as
silence.

### 2. bullmq's types are in the public surface, and in consumer code

This is larger than the engine. Today:

| Where                            | bullmq type                                       |
| -------------------------------- | ------------------------------------------------- |
| `JobPublisher.queue(name)`       | returns bullmq `Queue`                            |
| `JobPublisher.publish(...)`      | returns bullmq `Job<T>`                           |
| `@JobHandler` method parameter   | receives bullmq `Job<T>`                          |
| `QueueOptions.worker`            | `Omit<BullWorkerOptions, 'connection'\|'prefix'>` |
| `QueueOptions.defaultJobOptions` | bullmq `JobsOptions`                              |
| `DashboardOptions.queues`        | `QueueSource.queue()` handed to `BullMQAdapter`   |

`examples/full/src/jobs/thumbnail.jobs.ts` imports `type { Job } from 'bullmq'`, so
the leak reaches the code a consumer writes. "Everything working with the new path"
therefore requires a dunx-owned job contract that every backend satisfies, and that
is a **breaking change** to `@dunx/infra/queue`'s types.

The shape to aim for, mirroring how `@dunx/dashboard` already restates bullmq
structurally in `contracts.ts`:

```ts
export interface AppJob<T = unknown> {
  readonly id: string;
  readonly name: string;
  readonly queue: string;
  readonly data: T;
  readonly attemptsMade: number;
  state(): Promise<JobState>;
  readonly result: unknown;
  readonly failedReason: string | undefined;
}
```

Whether bullmq's `Job` satisfies that as written, or needs a wrapper, is a
field-by-field check nobody has done. Do it before committing to the interface: a
structural fit means the Redis path costs no allocation per job.

The version consequence is the owner's call.

## What a queue has to do, and what this one will not

Reproduced from bullmq, because an app on Redis today must keep working:

- enqueue and claim, with at-least-once delivery
- a visibility timeout and stalled-job recovery
- retries with fixed and exponential backoff
- delayed jobs, priorities, per-worker concurrency
- job states, the handler's return value, and the failure reason
- repeatable and cron jobs
- rate limiting, dead-letter routing, bulk add
- retention and cleanup

**Out of scope, stated rather than discovered later:** flows and parent/child
dependencies, per-job logs, and per-queue metrics history. bullmq has all three.
An app using them stays on Redis, and the docs must say so.

### Claiming a job without two workers taking it

- **Postgres**: `SELECT ... FOR UPDATE SKIP LOCKED` inside a transaction.
- **SQLite**: no `SKIP LOCKED`, and `bun:sqlite` serialises writers anyway. A single
  `UPDATE ... SET claimed_by = ? WHERE id = (SELECT id ... LIMIT 1) RETURNING *` is
  atomic under its write lock. Verify `RETURNING` behaves under WAL with two
  processes before relying on it.

### Waking a worker

- **Postgres**: `LISTEN`/`NOTIFY`, the same primitive `PostgresRelay` now uses.
  Measured in PR #21 at 10 ms against 2012 ms for polling.
- **SQLite**: no cross-process notification exists. In one process an in-memory
  emitter is enough, which is Firecracker's case. Across processes it is polling,
  and the interval is the whole latency story. Measure it before promising a number.
- **Redis**: bullmq's `BZPOPMIN`, unchanged.

## The dashboard has to grow a queue panel, and that reverses a rule

CLAUDE.md: "dunx renders no queue UI. `{path}/queues` is bull-board, mounted...
**Do not re-add a queue panel.**" and "`@dunx/queue-dashboard` was deleted and must
not come back."

That prohibition was written because a hand-rolled panel was a worse bull-board.
bull-board reads bullmq and nothing else, so for a SQL queue it is not a worse
option, it is no option. The reason expires for the SQL backends and holds for
Redis.

So: **bull-board stays mounted for the Redis backend**, and a dunx panel serves the
SQL ones, reading through the same backend-agnostic reader the engine exposes. One
panel, not one per dialect. The rule in CLAUDE.md changes from "never" to "not for
bullmq", and the reversal gets recorded the way the module-subgraph reversal was.

Panel scope: queue list with counts by state, a job list per state, a job detail
showing data, result, failure and attempts, and retry/remove actions behind the
existing `commands: false` flag and the existing `authorize`.

## The cache

dunx has no cache contract at all today, so this is a new abstraction rather than a
second backend for one. It must be **persistent**, which rules out the in-process
map being anything but a test double.

The `ThrottleStore` precedent in `@dunx/http` is the shape: an abstract class, not
an interface, because an interface at an injection site is a boot error.

```ts
export abstract class CacheStore {
  abstract get<T>(key: string): Promise<T | undefined>;
  abstract set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  abstract delete(key: string): Promise<void>;
  abstract clear(prefix?: string): Promise<void>;
}
```

Implementations: `SqlCacheStore` over drizzle (one table: key, value, expires_at,
created_at, with an index on expires_at), `RedisCacheStore` over
`Bun.RedisClient`, and a memory one for tests. Expiry in batches on write or on a
schedule, which is what Solid Cache does and the reason it can hold a much larger
cache than a memory store.

Unlike the queue, this half is genuinely small: a TTL table is not years of edge
cases, and no mature library clears Rule 1 anyway (`@keyv/postgres` depends on
`pg`; `cache-manager` is a front for keyv adapters).

## Phases

| #   | Work                                                                                   |
| --- | -------------------------------------------------------------------------------------- |
| 0   | **Characterization tests** against the current bullmq behaviour, through HTTP only     |
| 1   | The job contract, `JobPublisher` and `JobDispatcher` retyped, bullmq adapted behind it |
| 2   | The SQL engine, SQLite first, behind a new `QueueModule` entry point                   |
| 3   | The Postgres dialect and the LISTEN/NOTIFY wake                                        |
| 4   | The dashboard queue panel for the SQL backends                                         |
| 5   | `CacheStore` and its implementations                                                   |
| 6   | Firecracker moves to SQLite                                                            |

Phase 1 is the one that must land with every existing test still green, because it
changes types under working code. Phase 0 is what makes that checkable.

## What phase 0 pins

The suite asserts through the example's HTTP routes and never imports a bullmq
type, so the same file runs unchanged against a SQL backend. Anything it cannot
observe through a route needs a route added to `examples/full` first.

- enqueue returns an id, and the job reaches `completed` with the handler's result
- a handler that throws retries to its attempt limit, then reports `failed` with a
  reason
- a delayed job is not claimed before its delay elapses
- concurrency: N jobs enqueued together all complete
- an unknown job name fails rather than being silently acknowledged
- a job id nobody enqueued is a 404
- in-process and `background: true` handlers both run and both return a result
- the publisher reports the queues it has opened
- shutdown does not drop an in-flight job
- with the backend unreachable, publishing degrades to 503 rather than hanging
