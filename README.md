<div align="center">

<img src="internal/docs/public/logo/logo-mark-color.svg" width="96" height="96" alt="" />

# dunx

**NestJS-style structure at Bun speed.** Controllers, modules and dependency
injection, with no `reflect-metadata`, no `forwardRef`, and no JavaScript router.

[![CI](https://github.com/petarzarkov/dunx/actions/workflows/ci.yml/badge.svg)](https://github.com/petarzarkov/dunx/actions/workflows/ci.yml)
[![coverage](https://petarzarkov.github.io/dunx/badges/coverage.svg)](https://petarzarkov.github.io/dunx/#/coverage)
[![docs](https://img.shields.io/badge/docs-petarzarkov.github.io%2Fdunx-blue)](https://petarzarkov.github.io/dunx)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.3-black.svg)](https://bun.sh)

</div>

```bash
bunx @dunx/create-app my-api
```

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

That is the whole programming model. Note what is **not** there: no `@Injectable()`,
no `@Inject()`, no `reflect-metadata` import, no `experimentalDecorators` in your
tsconfig, and no `Response.json()` to remember. Two lines in `bunfig.toml` turn the
constructor types into wiring:

```toml
preload = ["@dunx/transform/preload"]

[test]
preload = ["@dunx/transform/preload"]
```

Bun's test runner reads its own `preload`, so the `[test]` entry is what keeps
`bun test` working. Miss it and the app runs while the suite fails at the first
provider with a constructor parameter.

## Three things that are different

**No `reflect-metadata`, and no `experimentalDecorators`.** dunx uses standard TC39
decorators. `@dunx/transform` reads each class's constructor parameter types at load
time with [`oxc-parser`](https://github.com/oxc-project/oxc) - a Rust parser over
N-API - and records them on the class. There are no parameter decorators in the TC39
proposal, so `@Inject()` does not exist and never will.

**A type that erases is a boot error, not `undefined`.** Annotate a parameter with an
interface, a primitive or a type-only import and dunx fails at boot naming that exact
parameter. `emitDecoratorMetadata` hands you `undefined` and a stack trace three
frames from where the mistake was.

**No `forwardRef`.** The dependency record is a thunk, evaluated at resolution rather
than at class-definition time, so a circular import resolves on its own. Nothing to
annotate, nothing to remember.

One thing to add rather than delete: **every relative import ends in `.js`**, because
`moduleResolution: nodenext` is what the scaffold sets. An extensionless specifier is a
compile error, not a runtime surprise.

## Benchmarks

Median req/s, 64 connections, 5 runs. `@dunx/http` is a layer over
`Bun.serve({ routes })`, so the gap to the raw row is dunx overhead and nothing else.

| Framework            | Plain text  | JSON        | Path param  | Body validation |
| -------------------- | ----------- | ----------- | ----------- | --------------- |
| **@dunx/http**       | **137,539** | **119,912** | **124,867** | **75,769**      |
| Elysia               | 135,907     | 127,524     | 129,497     | 74,858          |
| Hono (Bun)           | 106,793     | 91,586      | 86,031      | 51,576          |
| Fastify (Node)       | 42,923      | 42,871      | 44,309      | 18,642          |
| NestJS (Fastify)     | 37,075      | 36,219      | 32,967      | 16,033          |
| _Bun.serve (raw)_    | _136,940_   | _133,311_   | _128,930_   | _89,047_        |

That is **3.3-4.7x NestJS on Fastify**, and 85-100% of raw `Bun.serve` depending on
the scenario. Boot is **55 ms** against NestJS+Fastify's 287 ms.

The harness runs Go, Rust and JVM subjects alongside these, and the NestJS
subject is real NestJS with real `reflect-metadata` rather than a strawman. It
also states what it cannot measure: the load generator shares a machine with
the subject, and the closed-loop design is subject to coordinated omission.

Reproduce it with `bun run --filter '@dunx/bench' start`; the methodology is in
[internal/bench/README.md](internal/bench/README.md).

## Documentation

- **[The guide](https://petarzarkov.github.io/dunx)** - twenty-one pages,
  introduction through agent tooling
- **[Migrating from NestJS](docs/MIGRATION-FROM-NEST.md)** - what maps across and
  what does not
- **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** - what was measured, what was rejected,
  and why
- **[ROADMAP.md](docs/ROADMAP.md)** - what is built and what is next

## When not to use it

Being honest about this up front is cheaper than a disappointed issue later.

- **You do not want DI.** Elysia and Hono own this space, they are mature, and they
  are faster to learn. The DI is the entire reason dunx exists; without it you are
  paying boot cost and concepts for nothing.
- **Boot time is your critical number.** 55 ms is fine for a service that starts once
  and stays up, and wrong for a per-invocation serverless function.
- **You need request-scoped or transient providers.** Not supported, rejected with
  measurements.
- **You are not certain you are on Bun.** No CommonJS build, no Node compatibility
  layer. `Bun.serve`, `bun:sqlite`, `Bun.RedisClient` and `Bun.password` are
  load-bearing throughout.
- **You want a mature third-party ecosystem.** There is not one yet.

## Examples

A ladder, not one per package. All four are kept alive by CI, and each exits 0 with
no database, Redis or S3 installed.

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
| [`@dunx/auth`](./packages/auth) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fauth)](https://www.npmjs.com/package/%40dunx%2Fauth) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fauth?label=dls)](https://www.npmjs.com/package/%40dunx%2Fauth) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fauth?label=size)](https://www.npmjs.com/package/%40dunx%2Fauth) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-auth.svg)](https://petarzarkov.github.io/dunx/#/coverage) | Better Auth for dunx: its handler mounted on Bun.serve, a session guard reading @Public() and @Roles(), the caller in async context, and Bun.password hashing |
| [`@dunx/core`](./packages/core) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fcore)](https://www.npmjs.com/package/%40dunx%2Fcore) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fcore?label=dls)](https://www.npmjs.com/package/%40dunx%2Fcore) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fcore?label=size)](https://www.npmjs.com/package/%40dunx%2Fcore) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-core.svg)](https://petarzarkov.github.io/dunx/#/coverage) | DI container, modules, lifecycle and the injectable Logger contract for the dunx framework |
| [`@dunx/dashboard`](./packages/dashboard) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fdashboard)](https://www.npmjs.com/package/%40dunx%2Fdashboard) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fdashboard?label=dls)](https://www.npmjs.com/package/%40dunx%2Fdashboard) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fdashboard?label=size)](https://www.npmjs.com/package/%40dunx%2Fdashboard) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-dashboard.svg)](https://petarzarkov.github.io/dunx/#/coverage) | An opt-in operations page for a running dunx app: routes, the provider graph, gateways, config and runtime health, with bull-board mounted for the queues |
| [`@dunx/http`](./packages/http) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fhttp)](https://www.npmjs.com/package/%40dunx%2Fhttp) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fhttp?label=dls)](https://www.npmjs.com/package/%40dunx%2Fhttp) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fhttp?label=size)](https://www.npmjs.com/package/%40dunx%2Fhttp) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-http.svg)](https://petarzarkov.github.io/dunx/#/coverage) | Bun.serve adapter for the dunx framework: controllers, middleware and WebSocket gateways |
| [`@dunx/infra`](./packages/infra) | [![npm](https://img.shields.io/npm/v/%40dunx%2Finfra)](https://www.npmjs.com/package/%40dunx%2Finfra) [![dls](https://img.shields.io/npm/dt/%40dunx%2Finfra?label=dls)](https://www.npmjs.com/package/%40dunx%2Finfra) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Finfra?label=size)](https://www.npmjs.com/package/%40dunx%2Finfra) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-infra.svg)](https://petarzarkov.github.io/dunx/#/coverage) | Database, Redis, queue, storage, image and logging infrastructure for dunx. drizzle over bun:sqlite and Bun.SQL, bullmq over Bun.RedisClient, plus Bun.file, Bun.Glob, Bun.S3Client, Bun.Image and @arkv/logger |
| [`@dunx/openapi`](./packages/openapi) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fopenapi)](https://www.npmjs.com/package/%40dunx%2Fopenapi) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fopenapi?label=dls)](https://www.npmjs.com/package/%40dunx%2Fopenapi) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fopenapi?label=size)](https://www.npmjs.com/package/%40dunx%2Fopenapi) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-openapi.svg)](https://petarzarkov.github.io/dunx/#/coverage) | OpenAPI 3.1 documents and a dependency-free docs page for dunx controllers, generated from the schemas the routes already validate |
| [`@dunx/testing`](./packages/testing) | [![npm](https://img.shields.io/npm/v/%40dunx%2Ftesting)](https://www.npmjs.com/package/%40dunx%2Ftesting) [![dls](https://img.shields.io/npm/dt/%40dunx%2Ftesting?label=dls)](https://www.npmjs.com/package/%40dunx%2Ftesting) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Ftesting?label=size)](https://www.npmjs.com/package/%40dunx%2Ftesting) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-testing.svg)](https://petarzarkov.github.io/dunx/#/coverage) | Test harness for dunx apps: a container with providers replaced in place, and a real Bun.serve on port 0 |
| [`@dunx/transform`](./packages/transform) | [![npm](https://img.shields.io/npm/v/%40dunx%2Ftransform)](https://www.npmjs.com/package/%40dunx%2Ftransform) [![dls](https://img.shields.io/npm/dt/%40dunx%2Ftransform?label=dls)](https://www.npmjs.com/package/%40dunx%2Ftransform) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Ftransform?label=size)](https://www.npmjs.com/package/%40dunx%2Ftransform) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-transform.svg)](https://petarzarkov.github.io/dunx/#/coverage) | Load-time transform that records constructor dependencies for the dunx container |
| [`@dunx/create-app`](./tools/create-app) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fcreate-app)](https://www.npmjs.com/package/%40dunx%2Fcreate-app) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fcreate-app?label=dls)](https://www.npmjs.com/package/%40dunx%2Fcreate-app) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fcreate-app?label=size)](https://www.npmjs.com/package/%40dunx%2Fcreate-app) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-create-app.svg)](https://petarzarkov.github.io/dunx/#/coverage) | Scaffold a new dunx application - bunx @dunx/create-app my-api |
| [`@dunx/mcp`](./tools/mcp) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fmcp)](https://www.npmjs.com/package/%40dunx%2Fmcp) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fmcp?label=dls)](https://www.npmjs.com/package/%40dunx%2Fmcp) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fmcp?label=size)](https://www.npmjs.com/package/%40dunx%2Fmcp) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-mcp.svg)](https://petarzarkov.github.io/dunx/#/coverage) | A Model Context Protocol server for dunx apps - bunx @dunx/mcp ./src/app.module.ts |

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
