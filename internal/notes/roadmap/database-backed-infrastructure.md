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

`PubSubRelay` is two methods, and `Bun.SQL`'s `LISTEN`/`NOTIFY` is those two methods,
so a relay needs no adapter. Two real dunx nodes, a client on one, a publish on the
other: the frame crosses, on the default `dunx:ws` channel, with `relayChannel`
untouched. The measurement and the 7.9 KB frame ceiling are in
[architecture/http.md](../../../docs/architecture/http.md), "A Postgres relay
satisfies the same two methods".

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

1. **File the Bun JSON binding bug.** The report is written and sits at the bottom of
   this file; posting it costs nothing and it is the gate on the queue being cheap
   later.
2. **Decide the relay.** It is additive, it is in `@dunx/http`, and the measurement
   is done.
3. **Hold the queue** until the Bun gaps close or someone asks for it.
4. **Hold the cache** until something other than symmetry with Rails argues for it.

## The Bun report, ready to file

Not yet filed. Post it at `oven-sh/bun`, then replace this section with the issue
number the way [bun-1.4-adoption](./bun-1.4-adoption.md) records #40892 and #40893.

---

**Title:** `Bun.SQL`: a string parameter bound to a `::json` cast arrives as a JSON
string scalar

**What version of Bun is running?** 1.4.0+34cbb9a40, Linux x64. Postgres 17.

**What steps will reproduce the bug?**

```ts
const sql = new Bun.SQL({
  url: 'postgres://postgres:postgres@localhost:5432/postgres',
});

// A JSON document, already serialised - what every `pg`-based library passes.
const payload = JSON.stringify([{ id: 1, name: 'a' }]);

const [row] = await sql.unsafe(
  'SELECT json_typeof($1::json) AS kind, $1::json AS value',
  [payload],
);
console.log(row); // { kind: "string", value: '[{"id":1,"name":"a"}]' }
//                   expected: { kind: "array", value: [ { id: 1, name: "a" } ] }

// The consequence: anything that reads the document server-side fails.
await sql.unsafe(
  'SELECT * FROM json_to_recordset($1::json) AS x(id int, name text)',
  [payload],
); // PostgresError: cannot call json_to_recordset on a scalar

await sql.close();
```

**What is the expected behaviour?**

`json_typeof` answers `array`, and `json_to_recordset` returns one row per element.
`node-postgres` does exactly that against the same server and the same statement:

```
pg       json_typeof -> array
Bun.SQL  json_typeof -> string
```

**What do you see instead?**

Postgres receives the JSON document wrapped as a JSON string, so `$1::json` is a
scalar rather than the array the text spells out. Passing the parsed value instead of
the string works, which is what identifies the encoding as the cause rather than the
cast.

**Additional information**

This makes `Bun.SQL` unusable as the driver behind a library that serialises JSON
parameters itself, which is the normal shape for anything written against `pg`.
pg-boss builds its entire insert path on `json_to_recordset($1::json)` with a
`JSON.stringify`d argument, so every `send` fails. The workaround is to parse the
string back before binding, which needs the caller to know which placeholders carry a
`::json` cast.

Related, and already reported: a JS array parameter is comma-joined rather than
rendered as a Postgres array literal (#16840, #17798, #18775, #22165). The two
together are what stand between `Bun.SQL` and a `pg`-shaped library.
