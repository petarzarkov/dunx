<div align="center">

<img src="internal/docs/public/logo/logo-mark-color.svg" width="96" height="96" alt="" />

# dunx

<!-- positioning:start -->

**Everything a service needs. On Bun. One version.**

Controllers, dependency injection, validation, OpenAPI, WebSockets, queues, an
ORM, auth, a test harness and an ops dashboard. Released together, tested
together, on Bun's own primitives.

<!-- positioning:end -->

[![CI](https://github.com/petarzarkov/dunx/actions/workflows/ci.yml/badge.svg)](https://github.com/petarzarkov/dunx/actions/workflows/ci.yml)
[![coverage](https://dunx.win/badges/coverage.svg)](https://dunx.win/coverage)
[![docs](https://img.shields.io/badge/docs-dunx.win-blue)](https://dunx.win)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.4-black.svg)](https://bun.sh)

</div>

```bash
bunx @dunx/create-app my-api
```

## What you get

Elysia and Hono hand you a router, and everything above it is yours to choose
and keep in step. This is the other trade: one dependency, one release train.

| You need           | dunx gives you                                                         |
| ------------------ | ---------------------------------------------------------------------- |
| Structure          | Controllers, scoped modules, constructor DI, lifecycle hooks           |
| Requests           | `Bun.serve` routing, middleware, guards, CORS, compression, throttling |
| Validation         | Standard Schema, so zod, Valibot or ArkType all drop in                |
| API documentation  | OpenAPI 3.1 from the schemas the routes already validate, Swagger UI   |
| Realtime           | WebSocket gateways on the same port, with a Redis relay for many nodes |
| Data               | drizzle over `bun:sqlite` and `Bun.SQL`, transactions, seeds, paging   |
| Background work    | bullmq over `Bun.RedisClient`, sandboxed processors, `@Cron`           |
| Storage and images | One `Storage` contract over `Bun.file` and `Bun.S3Client`, `Bun.Image` |
| Auth               | better-auth mounted, a session guard, `Bun.password` hashing           |
| Calling out        | An HTTP client with retry, backoff and trace propagation               |
| Operating it       | Health checks, structured logging, an ops dashboard, bull-board        |
| Testing            | The real container with bindings replaced, a real server on port 0     |
| Tooling            | A scaffolder, and an MCP server so an agent can read your app          |

Every one of those is a Bun primitive or a best-in-class library wired to one,
never a reimplementation. Each is opt-in: `@dunx/core` has zero dependencies,
and an app that imports no queue installs no queue.

## What an app looks like

```ts
import { Logger, Module } from '@dunx/core';
import {
  Controller,
  Get,
  HttpFactory,
  type Input,
  type RouteSchemas,
} from '@dunx/http';

export class GreetingsService {
  constructor(private readonly logger: Logger) {}

  greet(name: string) {
    this.logger.info('greeting', { name });
    return { greeting: `hello, ${name}` };
  }
}

@Controller('greetings')
export class GreetingsController {
  constructor(private readonly greetings: GreetingsService) {}

  @Get('/:name')
  one(input: Input<RouteSchemas>) {
    return this.greetings.greet(input.req.params['name'] ?? 'world');
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

That is the whole programming model. There is no `@Injectable()`, no
`@Inject()`, no `reflect-metadata` import, no `experimentalDecorators`, and no
`Response.json()` to remember. Two lines in `bunfig.toml` turn the constructor
types into wiring:

```toml
preload = ["@dunx/transform/preload"]

[test]
preload = ["@dunx/transform/preload"]
```

Bun's test runner reads its own `preload`, so the `[test]` entry is what keeps
`bun test` working. Miss it and the app runs while the suite fails at the first
provider with a constructor parameter.

## How the DI differs

The constructor injection above reads like NestJS. The mechanism resolving it
underneath is different, in four places.

**No `reflect-metadata`, and no `experimentalDecorators`.** dunx uses standard
TC39 decorators. `@dunx/transform` reads each class's constructor parameter
types at load time with [`oxc-parser`](https://github.com/oxc-project/oxc), a
Rust parser over N-API, and records them on the class. There are no parameter
decorators in the TC39 proposal, so `@Inject()` does not exist and never will.

**A type that erases is a boot error.** Annotate a parameter with an interface,
a primitive or a type-only import and dunx fails at boot naming that exact
parameter. `emitDecoratorMetadata` hands you `undefined` and a stack trace three
frames from where the mistake was.

**No `forwardRef`.** The dependency record is a thunk, evaluated at resolution
rather than at class-definition time, so a circular import resolves on its own.

One thing to add rather than delete: **every relative import ends in `.js`**,
because `moduleResolution: nodenext` is what the scaffold sets. An extensionless
specifier is a compile error rather than a runtime surprise.

## Documentation

- **[The guide](https://dunx.win)** - twenty-one pages,
  introduction through agent tooling
- **[Migrating from NestJS](docs/MIGRATION-FROM-NEST.md)** - what maps across and
  what does not
- **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** - what was measured, what was
  rejected, and why
- **[ROADMAP.md](docs/ROADMAP.md)** - what is built and what is next
- **[setup.md](https://dunx.win/setup.md)** - the same setup for
  an agent to fetch and follow: "set up my project using
  https://dunx.win/setup.md". Every scaffolded app also gets an
  `AGENTS.md` and a `CLAUDE.md`
- **[llms.txt](https://dunx.win/llms.txt)** - every document
  above, linked as raw markdown

## Performance

Structure on Bun does not have to cost throughput. `@dunx/http` is a layer over
`Bun.serve({ routes })`. It lands at 88-99% of the raw server's throughput,
within noise of Elysia, and 3.8-5.5x NestJS on Fastify. Boot is 43 ms against
294 ms.

Median req/s, 64 connections, 5 runs:

| Framework         | Plain text  | JSON        | Path param  | Body validation |
| ----------------- | ----------- | ----------- | ----------- | --------------- |
| **@dunx/http**    | **134,864** | **127,776** | **126,206** | **81,631**      |
| Elysia            | 136,766     | 123,937     | 127,885     | 78,649          |
| Hono (Bun)        | 126,987     | 111,301     | 108,403     | 60,513          |
| NestJS (Fastify)  | 31,623      | 33,748      | 29,606      | 14,953          |
| _Bun.serve (raw)_ | _136,500_   | _131,077_   | _130,479_   | _92,616_        |

The harness also runs Go, Rust and JVM subjects alongside these. The NestJS
subject is real NestJS with real `reflect-metadata`. It states what it cannot
measure, too: the load generator shares a machine with the subject, and the
closed-loop design is subject to coordinated omission.

Reproduce it with `bun run --filter '@dunx/bench' start`. The methodology is in
[internal/bench/README.md](internal/bench/README.md).

## When not to use it

- **You do not want DI.** Elysia and Hono own that space, they are mature, and
  they are faster to learn.
- **Boot time is your critical number.** 43 ms is fine for a service that starts
  once and stays up, and wrong for a per-invocation serverless function.
- **You need request-scoped or transient providers.** Not supported, rejected
  with measurements.
- **You are not certain you are on Bun.** No CommonJS build, no Node
  compatibility layer. `Bun.serve`, `bun:sqlite`, `Bun.RedisClient` and
  `Bun.password` are load-bearing throughout.
- **You want a mature third-party ecosystem.** There is not one yet.

## Built with dunx

### [Firecracker](https://github.com/petarzarkov/firecracker) - [live](https://firecracker.petarzarkov.com/)

A provably-fair crash game: bet during the window, watch the rocket climb,
cash out before it explodes. Every round is verifiable after the fact.

21 modules, 8 controllers, a WebSocket gateway and 4 job handlers across 165
backend files, on `@dunx/core`, `@dunx/http`, `@dunx/infra`, `@dunx/auth`,
`@dunx/openapi`, `@dunx/testing`, `@dunx/transform`.

## Examples

Each is kept alive by CI. Each also exits 0 with no database, Redis or S3
installed.

| Example                                      | Answers                                                              |
| -------------------------------------------- | -------------------------------------------------------------------- |
| [`examples/minimal`](./examples/minimal)     | What does it look like? Five files, read top to bottom in two minutes |
| [`examples/databases`](./examples/databases) | How do I set up a database? SQLite (async and sync), Postgres, MySQL  |
| [`examples/testing`](./examples/testing)     | How do I test it? Overrides, a real server on port 0, a guard         |
| [`examples/full`](./examples/full)           | Does it compose? Every package in one long-running service            |

```bash
bun install
bun run --filter '@dunx/example-minimal' start
```

## Packages

| Package | Npm | Coverage | Description |
|---------|---------|----------|-------------|
| [`@dunx/auth`](./packages/auth) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fauth)](https://www.npmjs.com/package/%40dunx%2Fauth) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fauth?label=dls)](https://www.npmjs.com/package/%40dunx%2Fauth) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fauth?label=size)](https://www.npmjs.com/package/%40dunx%2Fauth) | [![cov](https://dunx.win/badges/coverage-auth.svg)](https://dunx.win/coverage) | Better Auth for dunx: its handler mounted on Bun.serve, a session guard reading @Public() and @Roles(), the caller in async context, and Bun.password hashing |
| [`@dunx/core`](./packages/core) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fcore)](https://www.npmjs.com/package/%40dunx%2Fcore) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fcore?label=dls)](https://www.npmjs.com/package/%40dunx%2Fcore) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fcore?label=size)](https://www.npmjs.com/package/%40dunx%2Fcore) | [![cov](https://dunx.win/badges/coverage-core.svg)](https://dunx.win/coverage) | DI container, modules, lifecycle and the injectable Logger contract for the dunx framework |
| [`@dunx/dashboard`](./packages/dashboard) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fdashboard)](https://www.npmjs.com/package/%40dunx%2Fdashboard) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fdashboard?label=dls)](https://www.npmjs.com/package/%40dunx%2Fdashboard) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fdashboard?label=size)](https://www.npmjs.com/package/%40dunx%2Fdashboard) | [![cov](https://dunx.win/badges/coverage-dashboard.svg)](https://dunx.win/coverage) | An opt-in operations page for a running dunx app: routes, the provider graph, gateways, config and runtime health, with bull-board mounted for the queues |
| [`@dunx/http`](./packages/http) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fhttp)](https://www.npmjs.com/package/%40dunx%2Fhttp) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fhttp?label=dls)](https://www.npmjs.com/package/%40dunx%2Fhttp) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fhttp?label=size)](https://www.npmjs.com/package/%40dunx%2Fhttp) | [![cov](https://dunx.win/badges/coverage-http.svg)](https://dunx.win/coverage) | Bun.serve adapter for the dunx framework: controllers, middleware and WebSocket gateways |
| [`@dunx/infra`](./packages/infra) | [![npm](https://img.shields.io/npm/v/%40dunx%2Finfra)](https://www.npmjs.com/package/%40dunx%2Finfra) [![dls](https://img.shields.io/npm/dt/%40dunx%2Finfra?label=dls)](https://www.npmjs.com/package/%40dunx%2Finfra) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Finfra?label=size)](https://www.npmjs.com/package/%40dunx%2Finfra) | [![cov](https://dunx.win/badges/coverage-infra.svg)](https://dunx.win/coverage) | Database, Redis, queue, schedule, storage, image and logging infrastructure for dunx. drizzle over bun:sqlite and Bun.SQL, bullmq over Bun.RedisClient, plus Bun.file, Bun.Glob, Bun.S3Client, Bun.Image and @arkv/logger |
| [`@dunx/openapi`](./packages/openapi) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fopenapi)](https://www.npmjs.com/package/%40dunx%2Fopenapi) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fopenapi?label=dls)](https://www.npmjs.com/package/%40dunx%2Fopenapi) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fopenapi?label=size)](https://www.npmjs.com/package/%40dunx%2Fopenapi) | [![cov](https://dunx.win/badges/coverage-openapi.svg)](https://dunx.win/coverage) | OpenAPI 3.1 documents for dunx controllers, generated from the schemas the routes already validate, with Swagger UI mounted over them |
| [`@dunx/testing`](./packages/testing) | [![npm](https://img.shields.io/npm/v/%40dunx%2Ftesting)](https://www.npmjs.com/package/%40dunx%2Ftesting) [![dls](https://img.shields.io/npm/dt/%40dunx%2Ftesting?label=dls)](https://www.npmjs.com/package/%40dunx%2Ftesting) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Ftesting?label=size)](https://www.npmjs.com/package/%40dunx%2Ftesting) | [![cov](https://dunx.win/badges/coverage-testing.svg)](https://dunx.win/coverage) | Test harness for dunx apps: a container with providers replaced in place, and a real Bun.serve on port 0 |
| [`@dunx/transform`](./packages/transform) | [![npm](https://img.shields.io/npm/v/%40dunx%2Ftransform)](https://www.npmjs.com/package/%40dunx%2Ftransform) [![dls](https://img.shields.io/npm/dt/%40dunx%2Ftransform?label=dls)](https://www.npmjs.com/package/%40dunx%2Ftransform) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Ftransform?label=size)](https://www.npmjs.com/package/%40dunx%2Ftransform) | [![cov](https://dunx.win/badges/coverage-transform.svg)](https://dunx.win/coverage) | Load-time transform that records constructor dependencies for the dunx container |
| [`@dunx/create-app`](./tools/create-app) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fcreate-app)](https://www.npmjs.com/package/%40dunx%2Fcreate-app) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fcreate-app?label=dls)](https://www.npmjs.com/package/%40dunx%2Fcreate-app) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fcreate-app?label=size)](https://www.npmjs.com/package/%40dunx%2Fcreate-app) | [![cov](https://dunx.win/badges/coverage-create-app.svg)](https://dunx.win/coverage) | Scaffold a new dunx application - bunx @dunx/create-app my-api |
| [`@dunx/mcp`](./tools/mcp) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fmcp)](https://www.npmjs.com/package/%40dunx%2Fmcp) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fmcp?label=dls)](https://www.npmjs.com/package/%40dunx%2Fmcp) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fmcp?label=size)](https://www.npmjs.com/package/%40dunx%2Fmcp) | [![cov](https://dunx.win/badges/coverage-mcp.svg)](https://dunx.win/coverage) | A Model Context Protocol server for dunx apps - bunx @dunx/mcp ./src/app.module.ts |

## Contributing

Pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) is the full guide: how
to get set up, which checks CI runs, the repo's rules on native implementations and
third-party dependencies, and the house style a review will hold you to.

The short version: Bun only, no `npm`/`npx`/`yarn`/`pnpm`; `bun install` then
`bun run build` before anything else; run `lint:check`, `format:check`, `typecheck`
and `test:cov` before you push; conventional commits; a bug fix comes with the test
that would have caught it; and a claim about performance comes with the numbers.

## License

[MIT](LICENSE)
