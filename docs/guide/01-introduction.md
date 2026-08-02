# Introduction

dunx is a dependency injection framework for [Bun](https://bun.com). It gives you
modules, constructor injection, class-based controllers, lifecycle hooks and
guards, and it serves HTTP through `Bun.serve` rather than through a server it
wrote itself.

If you have written NestJS, the shape will be familiar within a minute:

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

Note what is absent. There is no `@Injectable()` on the service, no `@Inject()` in
the constructor, no `reflect-metadata` import, and no `experimentalDecorators` in
the tsconfig. Being listed in a module's `providers` is what makes a class
injectable, and the constructor parameter's type is read at load time by
`@dunx/transform`. [Providers](./03-providers.md) explains how, and what happens
when the type cannot be recovered.

## Rule 1, and its two halves

Every capability dunx ships must sit on a Bun-native API or a native low-level
implementation. That rule pulls in two opposite directions on purpose, and almost
every design decision in the framework falls out of one half or the other.

### Never reimplement what Bun already does

`Bun.serve({ routes })` handles path parameters, per-method dispatch and
404-on-method-miss in native Zig. So dunx does not ship a router. Its job is to
build the `routes` object at boot and hand it to Bun.
[Controllers](./05-controllers.md) covers what that means for you in practice: it
is why an unmatched method is a 404 rather than a 405, and why `enableCors()` has
to mount an explicit `OPTIONS` handler per path instead of inferring a preflight.

The same rule bans `express`, `ws`, `socket.io`, `ioredis`, `pg`, `mysql2`,
`better-sqlite3`, `sharp`, `glob`, `chokidar`, `axios`, `bcrypt`, `dotenv`,
`@aws-sdk/*` and `lodash` from the dependency tree. Bun already ships an
equivalent for each, and a JavaScript reimplementation of a platform primitive is
slower, larger and a maintenance liability. `.env` loading is the clearest case:
Bun reads `.env` and `.env.local` itself, so `ConfigModule` has no loader and dunx
has no `dotenv`.

There is one sanctioned exception to "Bun first", and it is the parser. Bun has no
API for reading a TypeScript file's constructor parameter types, so
`@dunx/transform` uses `oxc-parser`, a Rust parser over N-API. Native, compiled,
not a JavaScript AST library. That package is build-time only and is the reason it
is a separate package: merging it into `@dunx/core` would put a Rust parser in
every production deploy.

### Never invent what a mature library already solves

The other failure mode is worse. Hand-rolling an ORM, a validator, an auth system
or a job queue means years of edge cases, and a half-built one is a liability
dressed as a feature. Where Bun ships no primitive for a hard problem, dunx
integrates the best-in-class library instead of competing with it:

| Concern        | Library                             | How dunx relates to it                                          |
| -------------- | ----------------------------------- | ---------------------------------------------------------------- |
| Validation     | zod, Valibot, ArkType, TypeBox, ajv | Targets the Standard Schema interface, so any of them drops in   |
| ORM, migrations| drizzle-orm                         | `@dunx/infra/db` over `drizzle-orm/bun-sqlite` and `/bun-sql`    |
| Authentication | better-auth                         | `@dunx/auth` mounts it and adds a guard, nothing of the flow     |
| Queues         | bullmq                              | `@dunx/infra/queue` over bullmq's `createBunRedisClient`         |

Those libraries are `peerDependencies`, never bundled. You install and own the
version. Where the library offers a Bun-native driver, that driver is mandatory:
`drizzle-orm/bun-sqlite`, not `better-sqlite3`. The library owns the abstraction,
Bun owns the I/O, and both halves of Rule 1 hold at once.

Validation is the cleanest illustration of the "interface, not library" line.
`@dunx/http` restates the Standard Schema v1 types in one file and depends on no
validator at all. Anything with a `~standard` property qualifies, including a
hand-written object. TypeBox 0.34 and ajv 8 do not ship `~standard`, and both were
bridged in about ten lines each in the benchmark harness, with no change to
`@dunx/http`.

## What dunx deliberately does not do

These are decisions, not gaps. Each one is recorded with its reasoning in
[ARCHITECTURE.md](../ARCHITECTURE.md).

**No `@Injectable()` and no `@Inject()`.** TC39 standard decorators have no
parameter decorators, so `@Inject()` has no migration path off the legacy dialect
and will never exist here. `inject()` in a field initializer is the escape hatch
for the cases a constructor parameter cannot express.

**No module encapsulation.** The container is flat. `imports` is traversal only:
it pulls a module's registrations into the same container. There is no `exports`
list, no visibility boundary, and therefore no "provider is not exported from
module X" error. This is the largest deliberate divergence from Nest and the first
thing you will notice. What is genuinely lost is per-module rebinding, and the
answer is to use two tokens. See [Modules](./04-modules.md).

**No `forwardRef`.** The dependency record `@dunx/transform` writes is a thunk,
evaluated at resolution rather than at class-definition time, so a dependency
declared later in the file or reached across a circular import resolves without
ceremony.

**No request-scoped DI.** Every provider is a singleton. Request-scoped DI is
Nest's single biggest source of complexity and per-request cost. Per-request state
is an explicit argument; request-scoped correlation is `AsyncLocalStorage` through
`RequestContext`, which never touches the container.

**No JavaScript router.** Covered above.

**No lazy resolution.** `AppFactory.create()` instantiates every provider and
awaits every async factory before the server binds, so wiring errors surface at
boot rather than at first request. That is also what lets `inject()` stay
synchronous. It costs boot time, and the cost is measured below.

**No CommonJS, no Node.** Every package is ESM only and Bun only.

## The measured position

`@dunx/http` sits on `Bun.serve`. The single most useful number the benchmark
harness produces is the gap between the two, because that gap is dunx's own
overhead and nothing else. From
[`tools/bench/README.md`](../../tools/bench), run on an AMD Ryzen 9 5950X with 32
logical cores, Bun 1.3.14, oha 1.15.0, 64 connections, 3 s warmup, 5 measured runs
of 5 s, dated 2026-08-02:

| Scenario    | raw `Bun.serve` | `@dunx/http` | dunx costs | Elysia          |
| ----------- | --------------: | -----------: | ---------: | --------------: |
| `plaintext` | 138,507 req/s   | 135,442      | 2.2%       | 132,503 (95.7%) |
| `json`      | 130,055 req/s   | 123,306      | 5.2%       | 124,264 (95.5%) |
| `params`    | 126,000 req/s   | 123,263      | 2.2%       | 124,507 (98.8%) |
| `validate`  | 84,701 req/s    | 78,311       | 7.5%       | 70,831 (83.6%)  |

Read that with the harness's own rules. A figure at or above 100% would be noise,
not a win: dunx dispatches through `Bun.serve` and cannot serve a request faster
than the API it calls. Two full runs of the same code on the same idle machine
moved dunx's `vs bun-serve` figure by up to 3.2 points, so read a gap of 5 or more
points as signal and a gap of 2 as nothing.

Startup is the clearest loss, and it is a real one:

| Subject           | cold start to first served request (median of 7) |
| ----------------- | ------------------------------------------------: |
| raw `Bun.serve`   | 26.7 ms                                            |
| **`@dunx/http`**  | **53.1 ms**                                        |
| Elysia            | 58.2 ms                                            |
| raw `node:http`   | 72.8 ms                                            |
| Express           | 120.2 ms                                           |
| Fastify           | 146.1 ms                                           |
| NestJS (Express)  | 270.7 ms                                           |

Roughly twice raw `Bun.serve`, from the `oxc-parser` preload plus eager DI
resolution and route discovery. That is the trade this architecture makes on
purpose: paid once at boot, never per request. It is a real cost on a short-lived
process.

Two more numbers worth having before you commit to anything:

**Request logging is on by default and it is not free.** `@dunx/http` installs
`RequestLoggingMiddleware` outermost, writing one structured entry per request.
With it on, `plaintext` runs at 77,658 req/s against 135,442 with it off, so 56.1%
of raw `Bun.serve` instead of 97.8%. The remaining cost decomposes to about 1.3 µs
of reading `req.headers`, 0.9 µs of the `AsyncLocalStorage` scope, 2.1 µs of
building and serialising the entry, and 0.7 µs of reading `req.url`. Turn it off
with `HttpFactory.create(root, { requestLogging: false })` and sample at the edge
if you need the throughput, but know what you gave up.

**Parsing a body costs about three times what validating it costs.** Measured
against raw `Bun.serve`: putting a body on the wire and never reading it adds
0.27 µs, `await req.json()` adds 3.10 µs, and zod on top adds 0.94 µs. Every
Standard Schema validator measured, including Valibot, ArkType, TypeBox and ajv,
came in under the parse. So there is no throughput argument for choosing between
them. Pick on API, error quality and ecosystem.

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

**You need per-module rebinding.** One token bound to two different
implementations in two different features cannot be expressed. The container is
flat and one token has exactly one binding. Two tokens is the answer, and if that
answer is unacceptable for your architecture, Nest's module system is a real
feature dunx does not have.

**You need request-scoped or transient providers.** Not supported, rejected with
measurements, and not coming back.

**You are not on Bun, or you might not be.** There is no CommonJS build, no Node
compatibility layer, and `Bun.serve`, `bun:sqlite`, `Bun.RedisClient`,
`Bun.password` and `Bun.S3Client` are load-bearing throughout. Portability was
never a goal.

**You want MySQL or MariaDB through the ORM integration.** There is no drizzle
path for either on Bun at all.

**You want a mature ecosystem of third-party modules.** There is not one. dunx is
eight packages maintained in one repository. Nest has a decade of community
modules and dunx has none of them.

## Where to go next

[First steps](./02-first-steps.md) scaffolds an application and walks every
generated file. [Providers](./03-providers.md) is the DI deep dive.
[Modules](./04-modules.md) covers composition and the flat container.
[Controllers](./05-controllers.md) covers routing, validation and errors.

[ARCHITECTURE.md](../ARCHITECTURE.md) records what was measured, what was
rejected, and why. If a decision here looks arbitrary, its reasoning is in that
document.
