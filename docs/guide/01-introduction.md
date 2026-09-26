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

`@dunx/http` sits on `Bun.serve`, so the benchmark harness reports dunx as a share
of raw `Bun.serve` in the same run. On the 2026-09-09 run (Ryzen 9 5950X, Bun
1.4.2, 64 connections):

- **Throughput** is 92% to 99.7% of raw `Bun.serve` across plaintext, JSON,
  path parameters, validation and one Redis plus Postgres round trip, level with
  Elysia. On the round trip the framework is 0.3% of the request.
- **Cold start** to the first served request is 46 ms against raw `Bun.serve`'s
  24 ms, for the `oxc-parser` preload plus eager resolution. Paid once, at boot.
- **Request logging is on by default** and is the largest per-request cost dunx
  adds. [Logging](./13-logging.md) covers turning it off.

Hardware, method, every scenario and what the harness does not measure:
[the benchmark harness](../architecture/benchmarks.md).

## When not to use dunx

**You do not want dependency injection.** Elysia and Hono are the main Bun web
frameworks. They are mature and quicker to learn, but neither has DI, modules or
class-based controllers, and dunx exists to provide those. If you would not use
the DI, you pay its boot time and learning cost for nothing.

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

**You want MySQL or MariaDB without writing a backend.** The database module has two
backends: `bun:sqlite`, and `Bun.SQL` for Postgres. `drizzle-orm/bun-sql` always
uses the Postgres dialect, so a MySQL URL fails when the connection is built,
with an error saying so. MySQL and MariaDB do work through
`drizzle-orm/mysql-proxy` over `Bun.SQL`, but you write the backend yourself, as
a `DbOptions` subclass. [`examples/databases`](https://github.com/petarzarkov/dunx/tree/main/examples/databases)
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
