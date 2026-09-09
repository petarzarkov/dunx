# Introduction

dunx is a dependency injection framework for [Bun](https://bun.com). It gives you
modules, constructor injection, class-based controllers, lifecycle hooks and
guards. HTTP is served through `Bun.serve`, not through a server dunx wrote.

There is a running app at [demo.dunx.win](https://demo.dunx.win) if you would
rather click than read: it is `examples/full`, which uses every package in this
guide, and its API explorer, ops dashboard and queue board are all open.

The architecture follows the pattern Spring and Angular established. A container
owns object lifetimes. Metadata replaces wiring code. Modules draw domain
boundaries. If you have worked with either framework, the shape is familiar:

```ts
import { Module } from '@dunx/core';
import { Controller, Get, HttpFactory } from '@dunx/http';

export class GreetingsService {
  greet(name: string): string {
    return `hello, ${name}`;
  }
}

@Controller('greetings')
export class GreetingsController {
  constructor(private readonly greetings: GreetingsService) {}

  @Get('/')
  index(): { greeting: string } {
    return { greeting: this.greetings.greet('world') };
  }
}

@Module({
  controllers: [GreetingsController],
  providers: [GreetingsService],
})
export class AppModule {}

const app = await HttpFactory.create(AppModule);
await app.listen(3000);
```

Note what is absent: no `@Injectable()` on the service, no `@Inject()` in the
constructor, no `reflect-metadata` import, no `experimentalDecorators` in the
tsconfig.

Listing a class in a module's `providers` makes it injectable, and
`@dunx/transform` reads the constructor parameter's type at load time.
[Providers](./03-providers.md) explains how, and what happens when the type
cannot be recovered.

## What it is built on

**Bun does the I/O.** `Bun.serve({ routes })` matches paths, dispatches per method
and answers a method miss, in native Zig. dunx builds the routes object at boot
and hands it over. The same goes for SQLite, Postgres, Redis, S3, image resizing,
password hashing and `.env` loading: Bun already does each of those.
`ConfigModule` has no loader because Bun reads `.env` itself.

You can see where the line falls in the dependency tree: `@dunx/core` has **zero
dependencies**, and nothing in dunx pulls in express, `ws`, ioredis, pg, sharp or
dotenv.

The one exception is the parser. Bun cannot tell you a TypeScript constructor's
parameter types, so `@dunx/transform` reads them with
[oxc-parser](https://github.com/oxc-project/oxc), a Rust parser over N-API. It is
build-time only and ships as its own package. A production deploy carries no
parser.

**Libraries do the hard parts.** Where Bun has no primitive, dunx integrates
something mature rather than growing its own:

| Concern            | Library                             | What dunx adds                                        |
| ------------------ | ----------------------------------- | ----------------------------------------------------- |
| Validation         | zod, Valibot, ArkType, TypeBox, ajv | Nothing. Routes target the Standard Schema interface  |
| ORM and migrations | drizzle-orm                         | A module over `drizzle-orm/bun-sqlite` and `/bun-sql` |
| Authentication     | better-auth                         | The mount and a guard, none of the flow               |
| Queues             | bullmq                              | A module over bullmq's own `createBunRedisClient`     |

These are `peerDependencies`. You install them and you own the version, and where a
library has a Bun-native driver that driver is the one dunx uses.

Validation shows the shape of it best: `@dunx/http` restates the Standard Schema
types in one file and depends on no validator at all. Anything with a `~standard`
property works, a hand-written object included. TypeBox and ajv do not ship one, and
each took about ten lines to bridge in the benchmark harness without touching
`@dunx/http`.

## Design decisions

**TC39 decorators only.** The standard has no parameter decorators, so there is no
`@Inject()`. `inject()` in a field initializer covers what a constructor parameter
cannot express. No `@Injectable()` either: listing a class in `providers` is enough.

**Module scoping replaces globals and path matching.** Each module is a scope,
`exports` is its public surface, and `global: true` publishes one app-wide. These
are fields on the one options object. A module's `middleware` covers the routes
its own controllers declare. See [Modules](./04-modules.md).

**Circular imports work.** Dependencies are recorded as a thunk and read at
resolution, so a class declared later in the file, or across a circular import,
resolves without `forwardRef`.

**Singleton providers only.** Every provider lives for the container's lifetime.
Per-request state is an argument. Per-request correlation is `AsyncLocalStorage`
through `RequestContext`, which never touches the container.

**Eager resolution.** `AppFactory.create()` builds every provider and awaits every
async factory before the server binds. A wiring mistake fails at boot, not on the
first request that hits it. This costs boot time, measured below.

**ESM only, Bun only.** No CommonJS build, no Node compatibility layer.

## The measured position

`@dunx/http` sits on `Bun.serve`. The most useful number the benchmark harness
produces is the gap between the two: that gap is dunx's own overhead.

Run on an AMD Ryzen 9 5950X with 32 logical cores, Bun 1.4.2, Node 24.21.0, oha
1.15.0, 64 connections, 3 s warmup, 5 measured rounds of 5 s, dated 2026-09-09:

| Scenario    | raw `Bun.serve` | `@dunx/http` | % of raw |          Elysia |
| ----------- | --------------: | -----------: | -------: | --------------: |
| `plaintext` |   134,478 req/s |      133,993 |    99.6% | 133,151 (99.0%) |
| `json`      |   129,641 req/s |      123,999 |    95.6% | 122,220 (94.3%) |
| `params`    |   128,172 req/s |      120,942 |    94.4% | 127,701 (99.6%) |
| `validate`  |    90,015 req/s |       82,903 |    92.1% |  80,372 (89.3%) |
| `io`        |    27,721 req/s |       27,646 |    99.7% | 27,741 (100.1%) |

**dunx costs under 1% to 8%** against the API it dispatches through, and is level
with Elysia. Read a ratio as plus or minus one point. Anything under three points
is a tie: two full runs of the same code disagreed by a median of 0.6 points.

`io` is the one that leaves the process: a Redis `GET` and then a Postgres
`SELECT`. The framework is 0.3% of it. Every difference above it is smaller than
one query, which is the honest framing for the other four rows.

A figure at or above 100% would be noise: dunx dispatches through `Bun.serve` and
cannot serve a request faster than the API it calls.

Startup is the clearest loss, and it is a real one:

| Subject          | cold start to first served request (median of 7) |
| ---------------- | -----------------------------------------------: |
| raw `Bun.serve`  |                                          24.0 ms |
| **`@dunx/http`** |                                      **46.2 ms** |
| Elysia           |                                          51.9 ms |
| raw `node:http`  |                                          80.7 ms |
| Express          |                                         110.1 ms |
| Fastify          |                                         135.4 ms |
| NestJS (Express) |                                         243.7 ms |

dunx boots in **1.93x** raw `Bun.serve`'s time, for the `oxc-parser` preload plus
eager DI resolution and route discovery. Read the ratio rather than the
milliseconds: both absolute figures move with the Bun release, and have moved in
both directions.

Every figure here is **spawn to a request served**, not to `listen()` returning.
The second milestone is roughly 20 ms earlier on both, so a number measured that
way is not comparable with this table.

That cost is paid once at boot, never per request. It is a real cost on a
short-lived process.

Two more numbers worth having before you commit to anything:

**Request logging is on by default and costs throughput.** `@dunx/http` installs
`RequestLoggingMiddleware` outermost, writing one structured entry per request.
With it on, `plaintext` runs at 78,060 req/s against 137,539 with it off: 57.0%
of raw `Bun.serve` against 100.4%.

The cost decomposes to about 1.3 µs reading `req.headers`, 0.9 µs for the
`AsyncLocalStorage` scope, 2.1 µs building and serialising the entry, and 0.7 µs
reading `req.url`. Turn it off with
`HttpFactory.create(root, { requestLogging: false })` and sample at the edge.

**Parsing a body costs about three times what validating it costs.** Measured
against raw `Bun.serve`: putting a body on the wire and never reading it adds
0.27 µs, `await req.json()` adds 3.10 µs, and zod on top adds 0.94 µs.

Every Standard Schema validator measured, including Valibot, ArkType, TypeBox and
ajv, came in under the parse, so no throughput argument separates them. Pick on
API, error quality and ecosystem.

The harness does not measure absolute capacity, concurrency beyond one process,
behaviour under sustained load, TLS, HTTP/2, websockets or streaming. Its only
I/O is the `io` row's one Redis `GET` and one Postgres `SELECT`; no filesystem, no
upstream HTTP, and nothing about a pool under contention.

It does measure resident set and CPU per request, which this page does not
reproduce. dunx boots at 51.3 MiB against raw `Bun.serve`'s 34.6, and peaks at
71.9 against 60.5 while serving the `io` row.

On that one row the framework is **0.3%** of the request. That is a result about
this workload, not a law: a heavier query moves it further toward nothing, and an
endpoint that touches no service at all is the `plaintext` row instead. It is
enough to say the four rows above are the wrong thing to choose a framework on.

## When not to use dunx

**You do not want dependency injection.** Elysia and Hono own Bun's web-framework
space, they are mature, and they are faster to learn. Neither offers DI, modules
or class-based controllers, and that gap is the whole reason dunx exists. If you
would not use the DI, you are paying its boot cost and its concepts for nothing.

**Boot time is the number that matters.** A short-lived process, a serverless
function billed per invocation, or a CLI will feel the ~46 ms. dunx is built for a
service that starts once and stays up. Note also that the startup numbers were
taken on an idle 32-core desktop, which is not what a constrained serverless CPU
looks like.

**You need request-scoped or transient providers.** Not supported, rejected with
measurements, and not coming back.

**You are not on Bun, or you might not be.** There is no CommonJS build, no Node
compatibility layer, and `Bun.serve`, `bun:sqlite`, `Bun.RedisClient`,
`Bun.password` and `Bun.S3Client` are load-bearing throughout. Portability was
never a goal.

**You want MySQL or MariaDB with nothing to assemble.** The database module
ships two backends: `bun:sqlite`, and `Bun.SQL` for Postgres. `drizzle-orm/bun-sql`
builds a Postgres dialect unconditionally, so a MySQL URL is rejected at
construction with a message saying so. MySQL and MariaDB do run, through
`drizzle-orm/mysql-proxy` over `Bun.SQL`, but the backend is a `DbOptions` subclass
you write. [`examples/databases`](https://github.com/petarzarkov/dunx/tree/main/examples/databases)
ships a working one.

**You want a mature ecosystem of third-party modules.** There is not one. dunx is
ten published workspaces in one repository. The established frameworks have a decade or more
of community modules behind them and dunx has none.

## Where to go next

[First steps](./02-first-steps.md) scaffolds an application and walks every
generated file. [Providers](./03-providers.md) is the DI deep dive.
[Modules](./04-modules.md) covers composition, `exports` and module scoping.
[Controllers](./05-controllers.md) covers routing, validation and errors.

[ARCHITECTURE.md](../ARCHITECTURE.md) records what was measured, what was
rejected, and why. If a decision here looks arbitrary, its reasoning is in that
document.
