# A queue, a cache and websocket fan-out with no Redis

Rails 8 replaced Redis with Solid Queue, Solid Cache and Solid Cable, all backed by
the application's own database. This file holds the audit of whether dunx should do
the same: what each of the three layers would cost, what already exists to build on,
and what was measured rather than assumed.

Everything below was probed on Bun 1.4.0 (rev `34cbb9a40`) against Postgres 17. The
measurements live in the architecture docs; this file holds the decision.

Delete it once the three verdicts are taken.

## The three layers do not have the same answer

| Layer               | Stands on                               | Verdict                                |
| ------------------- | --------------------------------------- | -------------------------------------- |
| Fan-out (Cable)     | `Bun.SQL` `LISTEN`/`NOTIFY`, no library | works today, ~30 lines                 |
| Queue (Solid Queue) | pg-boss over a `Bun.SQL` adapter        | works, with a shim that is a liability |
| Cache (Solid Cache) | nothing that clears Rule 1              | no contract exists to extend           |

## Fan-out: the cheapest of the three, and the closest to done

`PubSubRelay` is two methods, and `Bun.SQL` has both under other names: `notify`,
`listen`, and `unlisten` on the handle. So a relay is a class of about thirty lines
renaming three calls, rather than the structural fit `RedisConnection` is. Two real
dunx nodes, a client on one, a publish on the other: the frame crosses, on the
default `dunx:ws` channel, with `relayChannel` untouched. The measurement and the
7.9 KB frame ceiling are in
[architecture/http.md](../../../docs/architecture/http.md), "A Postgres relay over
`LISTEN`/`NOTIFY`".

What is open is placement, not feasibility. `RedisRelay` sits in `@dunx/http` because
`Bun.RedisClient` is a global that costs the package no dependency, and `Bun.SQL` is
a global on the same terms. So the choice is a `PostgresRelay` beside it, or leaving
it as the 30 lines an app writes against a documented interface.

Against shipping it: the roadmap freezes new capability outside the core three, and
this is a capability. For it: it lands in `@dunx/http`, which is one of the three,
at an extension point that already exists.

## Queue: it runs, and the shim is the problem

pg-boss 12.28.1 over a `Bun.SQL` adapter completes the full lifecycle - migration,
dispatch, LISTEN/NOTIFY wake, retries - in 10 ms per job, with no `pg` connection
ever opened. Numbers and the connection census that proves the last claim are in
[architecture/queues.md](../../../docs/architecture/queues.md), "A Postgres-backed
queue, measured and not adopted".

The blocker is not performance. Three `Bun.SQL` binding gaps
([bun-apis.md](../../../docs/bun-apis.md)) sit between pg-boss and Bun, and the
adapter closes them by reading the `$n::type` casts out of pg-boss's own SQL. That
is a driver-compat layer maintained here, against another project's queries, failing
silently if either side changes. Two of the three gaps are open Bun issues; the JSON
one is unreported and worth filing.

The honest sequence is upstream first. File the JSON scalar bug, and see whether the
array binding lands in a Bun release. Both gaps closing turns the adapter into
`executeSql` plus `listen`, which is small enough to own.

The second cost does not expire: pg-boss has its own job model, and
`JobPublisher.for()` hands back bullmq's `Queue`. A pg-boss backend is a second
surface, not a driver behind the existing one.

## Cache: the one with nothing to lean on

dunx has no cache contract at all. Nothing in `packages/*` declares one, so this is
not a second backend for an existing abstraction, it is a new abstraction.

No library clears Rule 1 either. `@keyv/postgres` depends on `pg`; `cache-manager` is
a front for keyv adapters, so every SQL backend under it drags a banned driver in.

Unlike a queue, a TTL cache is not years of edge cases, and dunx has the shape
already: `ThrottleStore` in `@dunx/http` is an abstract class with an in-memory
implementation and a structurally-typed Redis one, and a `CacheStore` would be that
pattern with a SQL implementation added. That makes it buildable and leaves it the
most invented of the three, which is the argument against starting here.

## What the decision actually turns on

The roadmap freezes `infra` to maintenance and says a new package needs a user first,
citing `@dunx/queue-dashboard` as the cost of getting that wrong. All three of these
sit in or beside frozen ground.

The suggested order, if any of it proceeds:

1. **Watch the two Bun gaps.** The JSON one is filed as
   [#40942](https://github.com/oven-sh/bun/issues/40942), the array one is open on
   four issues, and both closing is the gate on the queue adapter being small.
2. **Decide the relay.** It is additive, it is in `@dunx/http`, and the measurement
   is done.
3. **Hold the queue** until the Bun gaps close or someone asks for it.
4. **Hold the cache** until something other than symmetry with Rails argues for it.

## Filed upstream

[oven-sh/bun#40942](https://github.com/oven-sh/bun/issues/40942): a string parameter
bound to a `::json` cast arrives as a JSON string scalar, so
`json_to_recordset($1::json)` fails against a document a `pg`-shaped library already
stringified. `node-postgres` answers `array` for `json_typeof` on the same statement,
which is in the report.

The array half was already open on #16840, #17798, #18775 and #22165. Both closing is
what turns the queue adapter from a driver-compat layer into `executeSql` plus
`listen`, which is the size worth owning.
