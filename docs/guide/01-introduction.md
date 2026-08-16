# Introduction

dunx is a dependency injection framework for [Bun](https://bun.com). It gives you
modules, constructor injection, class-based controllers, lifecycle hooks and
guards, and it serves HTTP through `Bun.serve` rather than through a server it
wrote itself.

The architecture is the one Spring and Angular established: inversion of control
with a container that owns object lifetimes, declarative metadata instead of wiring
code, and modules that draw domain boundaries. If you have worked in either, the
shape will be familiar within a minute:

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
and answers a method miss, in native Zig, so dunx ships no router: it builds the
routes object at boot and hands it over. The same goes for SQLite, Postgres, Redis,
S3, image resizing, password hashing and `.env` loading, each of which Bun already
does. `ConfigModule` has no loader because Bun reads `.env` itself.

You can see where the line falls in the dependency tree: `@dunx/core` has **zero
dependencies**, and nothing in dunx pulls in express, `ws`, ioredis, pg, sharp or
dotenv.

One exception, and it is the parser. Bun cannot tell you a TypeScript
constructor's parameter types, so `@dunx/transform` reads them with
[oxc-parser](https://github.com/oxc-project/oxc), a Rust parser over N-API. It is
build-time only and ships as its own package, so a production deploy carries no
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

## What it does not have

Decisions rather than gaps.

**No `@Injectable()`, no `@Inject()`.** TC39 decorators have no parameter
decorators, so `@Inject()` has nowhere to come from. `inject()` in a field
initializer covers what a constructor parameter cannot express.

**No `@Global()` decorator, no `forRoutes()`.** Modules do encapsulate - each is a
scope, `exports` is its public surface, and `global: true` publishes one app-wide -
but each of those is a field on the one options object rather than a second
spelling. A module's `middleware` covers the routes its own controllers declare, so
there is no path-matching language and no ancestor layer. See
[Modules](./04-modules.md).

**No `forwardRef`.** Dependencies are recorded as a thunk and read at resolution, so
a class declared later in the file, or across a circular import, resolves anyway.

**No request-scoped DI.** Every provider is a singleton. Per-request state is an
argument, and per-request correlation is `AsyncLocalStorage` through
`RequestContext`, which never touches the container.

**No lazy resolution.** `AppFactory.create()` builds every provider and awaits every
async factory before the server binds, so a wiring mistake fails at boot instead of
on the first request that hits it. It costs boot time, measured below.

**No CommonJS and no Node.** ESM only, Bun only.

## The measured position

`@dunx/http` sits on `Bun.serve`. The single most useful number the benchmark
harness produces is the gap between the two, because that gap is dunx's own
overhead and nothing else.

Run on an AMD Ryzen 9 5950X with 32 logical cores, Bun 1.3.14, oha 1.15.0, 64
connections, 3 s warmup, 5 measured runs of 5 s, dated 2026-08-02:

| Scenario    | raw `Bun.serve` | `@dunx/http` | dunx costs |          Elysia |
| ----------- | --------------: | -----------: | ---------: | --------------: |
| `plaintext` |   138,507 req/s |      135,442 |       2.2% | 132,503 (95.7%) |
| `json`      |   130,055 req/s |      123,306 |       5.2% | 124,264 (95.5%) |
| `params`    |   126,000 req/s |      123,263 |       2.2% | 124,507 (98.8%) |
| `validate`  |    84,701 req/s |       78,311 |       7.5% |  70,831 (83.6%) |

Read that with the harness's own rules. A figure at or above 100% would be noise,
not a win: dunx dispatches through `Bun.serve` and cannot serve a request faster
than the API it calls. Two full runs of the same code on the same idle machine
moved dunx's `vs bun-serve` figure by up to 3.2 points, so read a gap of 5 or more
points as signal and a gap of 2 as nothing.

Startup is the clearest loss, and it is a real one:

| Subject          | cold start to first served request (median of 7) |
| ---------------- | -----------------------------------------------: |
| raw `Bun.serve`  |                                          26.7 ms |
| **`@dunx/http`** |                                      **53.1 ms** |
| Elysia           |                                          58.2 ms |
| raw `node:http`  |                                          72.8 ms |
| Express          |                                         120.2 ms |
| Fastify          |                                         146.1 ms |
| NestJS (Express) |                                         270.7 ms |

Roughly twice raw `Bun.serve`, from the `oxc-parser` preload plus eager DI
resolution and route discovery. That is the trade this architecture makes on
purpose: paid once at boot, never per request. It is a real cost on a short-lived
process.

Two more numbers worth having before you commit to anything:

**Request logging is on by default and costs throughput.** `@dunx/http` installs
`RequestLoggingMiddleware` outermost, writing one structured entry per request.
With it on, `plaintext` runs at 77,658 req/s against 135,442 with it off: 56.1%
of raw `Bun.serve` against 97.8%.

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
anything with I/O, memory, behaviour under sustained load, TLS, HTTP/2, websockets
or streaming. In an application that talks to Postgres, every difference in the
table above is rounding error next to one query. That is the honest framing.

## When not to use dunx

**You do not want dependency injection.** Elysia and Hono own Bun's web-framework
space, they are mature, and they are faster to learn. Neither offers DI, modules
or class-based controllers, and that gap is the whole reason dunx exists. If you
would not use the DI, you are paying its boot cost and its concepts for nothing.

**Boot time is the number that matters.** A short-lived process, a serverless
function billed per invocation, or a CLI will feel the ~53 ms. dunx is built for a
service that starts once and stays up. Note also that the startup numbers were
taken on an idle 32-core desktop, which is not what a constrained serverless CPU
looks like.

**You need request-scoped or transient providers.** Not supported, rejected with
measurements, and not coming back.

**You are not on Bun, or you might not be.** There is no CommonJS build, no Node
compatibility layer, and `Bun.serve`, `bun:sqlite`, `Bun.RedisClient`,
`Bun.password` and `Bun.S3Client` are load-bearing throughout. Portability was
never a goal.

**You want MySQL or MariaDB through the ORM integration.** There is no drizzle
path for either on Bun at all.

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
