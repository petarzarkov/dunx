# Queues and cache on the database, with Redis optional

The target: Firecracker runs on SQLite alone and barely changes. A dunx consumer
picks `redis`, `sqlite` or `postgres` for its queue and gets a persistent cache on
the same store. `JobPublisher`, `QueueModule`, `@JobHandler`, the runner and the
relays all keep working on whichever it picked.

This file is the plan. Nothing below is built. Delete it when the phases are done
and the outcome is in `docs/architecture/queues.md`.

## Two things were settled before any code

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

**Decided: B**, two engines. What Rule 1 protects against is a half-built queue
competing with a mature one. For SQLite there is no mature one to compete with, so
that half is forced. Having written it, running the same SQL over Postgres costs a
dialect rather than a second job model, and it is the option where a consumer's
SQLite development database behaves like its Postgres production one. A is the more
faithful reading of Rule 1, and its cost lands on consumers rather than on dunx.

**pg-boss therefore has no role**, despite measuring well in PR #21. That
measurement stands as the evidence that the Postgres half was reachable by
integration; B trades it for one job model across both SQL dialects.

**Phase 1 adds the exception to CLAUDE.md.** Rule 1 keeps "do not write a dunx ORM,
a validator or an auth flow" and gains a named carve-out for the queue, with the
reason and the boundary: bullmq stays the Redis engine, and nothing here competes
with a library that exists.

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

**Decided: one break, at 4.0.** `AppJob` becomes the only shape a handler sees,
`JobPublisher` and `JobDispatcher` are retyped against it, and bullmq is adapted
behind it. A consumer's handler signature changes once, rather than the surface
carrying two job types for a release cycle.

**`AppJob` alone is not enough**, and the table above is the checklist. Every row
needs a dunx-owned replacement or an explicit "Redis only" label, because a
half-migrated surface is one where the backend still leaks:

| Surface                          | 4.0                                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JobPublisher.queue(name)`       | returns `JobQueue`, a dunx interface: `add`, `addBulk`, `getJob`, `counts`, `drain`, `remove`                                                                           |
| `JobPublisher.publish(...)`      | returns `AppJob<T>`                                                                                                                                                     |
| `@JobHandler` parameter          | `AppJob<T>`                                                                                                                                                             |
| `QueueOptions.worker`            | `WorkerTuning`: `concurrency`, `lockDurationMs`, `stalledIntervalMs`, `limiter`. Anything else is Redis only and moves under `redis: { worker }`                        |
| `QueueOptions.defaultJobOptions` | `JobOptions`: `attempts`, `backoff`, `delay`, `priority`, `removeOnComplete`, `removeOnFail`                                                                            |
| `DashboardOptions.queues`        | `QueueSource.queue()` keeps returning `unknown`, and the dashboard picks its renderer from a new `kind` on the source: bull-board for `redis`, the dunx panel for `sql` |

`buildBoard()` hands its queue straight to `BullMQAdapter`, which rejects anything
else, so the dashboard cannot be made backend-neutral by leaving that return type
`unknown`. The `kind` discriminator is what stops a SQL queue reaching bull-board.

**`AppJob.id` is `string`, and bullmq's is `id?: string`.** The adapter assigns at
publish rather than propagating the optionality: an id that may be absent makes
every status route and every dashboard row branch on it. Publishing without an id
is a `QueueError`, not a job. Phase 0 gains a test that a published job always
reports one.

The rest of the field comparison is still phase 1's first task, and it now decides
how thin the Redis adapter is rather than whether the break happens. `getState()`
against `state()` and `returnvalue` against `result` are the two others known to
differ.

## What a queue has to do, and what this one will not

Reproduced from bullmq, because an app on Redis today must keep working:

- enqueue and claim, with at-least-once delivery
- a visibility timeout and stalled-job recovery
- retries with fixed and exponential backoff
- delayed jobs, priorities, per-worker concurrency
- job states, the handler's return value, and the failure reason
- repeatable and cron jobs
- bulk add, retention and cleanup

**Out of scope, stated rather than discovered later:** flows and parent/child
dependencies, per-job logs, per-queue metrics history, **rate limiting** and
**dead-letter routing**. bullmq has all six. An app using them stays on Redis, and
the docs must say so.

### Claiming a job without two workers taking it

A row lock is not the mechanism, and reaching for one is the trap. `SELECT ... FOR
UPDATE SKIP LOCKED` holds only until the transaction ends, so committing the claim
before the handler runs lets a second worker take the same job, and holding the
transaction open for the handler's duration keeps a row lock for as long as the
work takes, which blocks the stalled-job sweep that has to reclaim it.

So the claim is **state written to the row**, and the lock only guards the
transition:

```sql
UPDATE jobs SET state = 'active', claimed_by = ?, lease_until = now() + interval
WHERE id = (SELECT id FROM jobs WHERE state = 'waiting' AND run_at <= now()
            ORDER BY priority, run_at LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING *
```

The transaction is one statement long. `lease_until` is the visibility timeout: a
sweep returns rows whose lease expired to `waiting` and increments the attempt, and
a worker renews the lease while its handler runs. That is what makes at-least-once
delivery survive a worker being killed mid-job.

- **SQLite**: no `SKIP LOCKED`, and `bun:sqlite` serialises writers anyway, so the
  same `UPDATE ... RETURNING` is atomic under its write lock without the subquery
  hint. **Verify `RETURNING` under WAL with two processes** before relying on it.
- **Two-worker test, both dialects**: N jobs, two workers, assert each job runs
  exactly once and no id is claimed twice. Kill one worker mid-job and assert the
  lease expiry hands it to the other.

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

`get<T>` and `set<T>` take independent type parameters, so nothing stops a caller
storing a number and reading a string. That is the same latitude `ConfigService`
gives and it is not worth a codec registry, but it does mean **the serialization
rules have to be written down rather than inherited from whatever `JSON.stringify`
happens to do**:

| Value                         | Stored as                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------ |
| JSON scalars, arrays, objects | `JSON.stringify`                                                               |
| `Date`                        | ISO 8601 string. **Read back as a string**, not a `Date`                       |
| `undefined`                   | rejected: it is indistinguishable from a miss                                  |
| `bigint`                      | rejected: `JSON.stringify` throws on it, and silently coercing loses precision |
| a missing key                 | `undefined`                                                                    |

The two rejections throw a `CacheError` at `set`, so the loss is at the write that
caused it rather than at a read weeks later.

**Expiry is a read-time invariant, not a cleanup schedule.** `get` filters on
`expires_at > now()` in the same statement that reads the row, so an expired entry
is a miss whether or not a sweep has run. Batch cleanup only reclaims space. A
contract test covers exactly that: write with a 1 second TTL, wait, read with no
sweep run, expect a miss.

`SqlCacheStore` over drizzle, one table:

| Column       | Notes                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `key`        | **primary key**. `set` is an upsert, so a rewrite replaces the value and the TTL in one statement rather than accumulating rows |
| `value`      | text, the serialized form above                                                                                                 |
| `expires_at` | nullable for no TTL, indexed for the sweep and the read filter                                                                  |
| `created_at` | for FIFO eviction                                                                                                               |

`RedisCacheStore` over `Bun.RedisClient` with the same rules, and a memory one for
tests only. Batch expiry on a schedule, which is what Solid Cache does and the
reason it can hold a much larger cache than a memory store.

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

## What phase 0 pins, and what it still owes

The suite asserts through the example's HTTP routes and never imports a bullmq
type, so the same file runs unchanged against a SQL backend. Anything it cannot
observe through a route needs a route added to `examples/full` first, which is why
this is a two-part list rather than one.

**Pinned now**, in `jobs.characterize.test.ts` and `jobs.test.ts`:

- a job runs in this process and reports the handler's return value
- a throwing handler retries and completes once it stops throwing
- the attempt limit is respected and the failure reason readable
- a delayed job reads `delayed`, then runs
- a batch enqueued at once all completes
- the publisher reports the queues it has opened
- a job id nobody enqueued is a 404
- with the backend unreachable, publishing degrades to 503 rather than hanging
- the forked `background: true` path runs and returns a result

**Still owed before phase 2 starts**, because the compatibility target above names
them and prose is not a test:

| Behaviour                 | Needs                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| stalled recovery          | a handler that exits without completing, and a lease short enough to observe the reclaim |
| a published job has an id | asserted directly, since `AppJob.id` is now non-optional                                 |
| priorities                | two jobs enqueued out of priority order, asserted in completion order                    |
| bulk add                  | a route over `addBulk`                                                                   |
| retention                 | `removeOnComplete`, then a status route that 404s                                        |
| cron and repeatable       | the `ScheduleModule` interplay, which has its own example already                        |
| shutdown mid-job          | `shutdown.test.ts` covers app teardown; it does not cover an in-flight job               |

**Narrowed out of the v1 target**, so they are neither characterized nor promised:
rate limiting and dead-letter routing. Both are bullmq features an app can keep by
staying on Redis, and neither is on Firecracker's path. Adding them later is
additive; promising them now and discovering the semantics differ is not.
