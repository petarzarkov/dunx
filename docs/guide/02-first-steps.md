# First steps

This page scaffolds an application, explains every file in it, and then adds a
route, a service and a test. It assumes Bun 1.4 or newer and nothing else.

## Scaffold

```bash
bunx @dunx/create-app my-api
```

It asks what the app should do. Enter on an empty selection gives the minimal
template:

```
✓ Features  none, the minimal template

Created my-api in my-api/
  12 files from the minimal template

Next:
  cd my-api
  bun install
  bun run dev  # or `start`, which does not watch
```

The target directory is the only positional argument. Four flags remain, and none
of them chooses anything about the app:

| Flag            | Effect                                                     |
| --------------- | ---------------------------------------------------------- |
| `--name <name>` | Package name for the app. Defaults to the directory's base |
| `--force`       | Write into a directory that already has files in it        |
| `--yes`, `-y`   | Skip the questions and take the minimal template           |
| `--help`        | Print usage                                                |

**Piped, or in CI, it asks nothing** and writes the minimal template, so a script
never blocks on a question nothing can answer. To choose features without a
terminal, call `scaffold({ target, features })` from `@dunx/create-app`.

Name the directory `.` to write into the one you are already in.

The package name is validated against npm's rules before anything is written, so a
directory called `My-API` produces a second question asking for a name npm takes,
rather than a directory whose `bun install` fails later. A directory that already
has files in it produces the other question, and answering no writes nothing.

Every `@dunx/*` version in the generated manifest is resolved at run time from the
version of `@dunx/create-app` doing the scaffolding. The packages version in
lockstep, so the right version to install is whatever generated the app, and the
template never goes stale between releases.

## Choosing features

The minimal template is five files and one route: small enough to read, thin
enough to start from. Anything more is composed from the list:

```
? Features  3 chosen, 1 pulled in
  ○ notes       CRUD routes with zod validation. The smallest real feature.
  ◉ openapi     OpenAPI 3.1 from the routes own schemas, plus the Swagger UI page.
  ◉ http        CORS, a middleware of your own on the response, and error mapping.
  ◈ database    drizzle over bun:sqlite, with a schema, seeds and migrations.
❯ ◉ users       A repository, a service and validated routes over the database.
  database comes along as a requirement.
  Space toggles. ↑↓ moves. a all, n none. Enter continues.
```

```
Created my-api in my-api/
  33 files, 4 features: openapi, http, database, users
  database came along as a requirement
```

`◉` is chosen, `◈` is pulled in by something else you chose, `○` is neither.
`↑` `↓` move, `k` and `j` do the same, `a` takes everything and `n` clears it.
Ctrl+C stops without writing.

The set:

| Feature      | What arrives                                                     | Pulls in                     |
| ------------ | ---------------------------------------------------------------- | ---------------------------- |
| `notes`      | CRUD routes with zod validation. The smallest real feature       |                              |
| `openapi`    | OpenAPI 3.1 from the routes' own schemas, plus the explorer page |                              |
| `http`       | CORS, a request-logging middleware and error mapping             |                              |
| `guards`     | `@Roles` and `@Public`, and a protected controller               |                              |
| `database`   | drizzle over `bun:sqlite`, with a schema, seeds and migrations   |                              |
| `users`      | A repository, a service and validated routes over the database   | `database`                   |
| `auth`       | better-auth mounted, with `SessionGuard` and an audit trail      | `database`                   |
| `cache`      | `Bun.RedisClient` behind a session store                         |                              |
| `websockets` | A `@Gateway` with `@OnMessage`, `PubSub` and a Redis relay       | `cache`                      |
| `images`     | `Bun.Image` resizing and format conversion behind a route        |                              |
| `files`      | Uploads and downloads on `Bun.file`                              |                              |
| `jobs`       | bullmq queues and a job processor, over `Bun.RedisClient`        | `images`                     |
| `health`     | Liveness and readiness probes, and which parts are degraded      | `cache`, `database`, `files` |

Requirements come along automatically. The list marks them `◈` while you choose.
Import order is construction order, so a database is built before the feature that
reads it and torn down after it. `cache`, `websockets` and `jobs` want a Redis or
Valkey. Each reports itself degraded rather than failing the boot, so the app still
starts without one.

### Where the code comes from

Every feature directory is copied out of dunx's own
[`examples/full`](https://github.com/petarzarkov/dunx/tree/main/examples/full).
CI builds, typechecks, tests and tours that service on every push. A byte-for-byte
parity test fails the moment a copy drifts from the example.

The wiring cannot be copied. `app.module.ts`, `config.ts` and `main.ts` name every
feature at once in the full example, so those three are **generated** for the
selection. The config carries only the variables your features read, and the
manifest only the dependencies they need.

CI scaffolds every feature alone, the whole set, and the combinations with
something to get wrong, then typechecks each one.

The `*.demo.ts` files are the full example's scripted walkthroughs, and they come
along because their module registers them. They are executable documentation of the
feature; delete one and its `providers` entry when you do not want it.

## What you got

```
my-api/
  bunfig.toml
  package.json
  tsconfig.json
  README.md
  AGENTS.md
  CLAUDE.md
  .gitignore
  src/
    main.ts
    app.module.ts
    greetings.service.ts
    greetings.controller.ts
    app.test.ts
```

### `bunfig.toml`

```toml
# The one line that makes constructor injection work. The compiler plugin records
# each class's constructor parameter types so the container can resolve them.
# Without it, providers are built with no arguments and boot fails saying so.
preload = ["@dunx/transform/preload"]

[test]
preload = ["@dunx/transform/preload"]
```

The only setup dunx asks for. Read it rather than copying it.

`@dunx/transform/preload` registers a Bun plugin. On load, the plugin parses each
`.ts` and `.tsx` file with `oxc-parser`, reads every class declaration's
constructor parameter types, and appends one statement after the class:

```ts
export class GreetingsService {
  constructor(private readonly logger: Logger) {}
}
Object.defineProperty(GreetingsService, Symbol.for('dunx.deps'), {
  value: () => [Logger],
});
```

The container reads that record and resolves the arguments before calling `new`.
Files under `node_modules` are skipped: a published package was already
transformed by its own build, and re-parsing dependencies on every load is pure
cost.

There are two `preload` entries because Bun's test runner reads its own. The
top-level one covers `bun run start` and `bun src/main.ts`; the `[test]` one
covers `bun test`. Miss the second and your app runs but your suite does not.

**What breaks without it.** The container compares the recorded dependency count
against `Function.prototype.length`, which still reports the declared parameter
count after TypeScript's parameter properties are compiled away. Zero recorded
dependencies plus a non-zero arity can only mean the plugin never saw the file.
Boot fails with a clear message carrying the fix:

```
GreetingsService declares 1 constructor parameter(s) but no dependencies were
recorded for it, so @dunx/transform did not transform GreetingsService. Register
the plugin, then retry:

  # bunfig.toml
  preload = ["@dunx/transform/preload"]

  [test]
  preload = ["@dunx/transform/preload"]
```

There are no false positives. A constructor whose parameters all have defaults
has `length === 0` and is genuinely callable with no arguments. A class bound
with `useValue` is never constructed. The transform only writes a record whose
length equals the parameter count, so a present record is never empty.

`@dunx/core` does not register the plugin on import, for two reasons, both fatal.

It would make DI import-order dependent. Bun's `onLoad` only affects modules
loaded after registration, and static imports evaluate depth-first in source
order, so `import { AppFactory } from '@dunx/core'` before your module would work
while the reverse order silently skipped the transform. That is the
"`reflect-metadata` must be the first import" fragility dunx exists to avoid.

It would also cost `@dunx/core` its empty dependency list. Every production
deploy would carry a Rust parser to run code already transformed at build time.

Two other places accept the same plugin object if `bunfig.toml` does not suit you:

```ts
import { depsPlugin } from '@dunx/transform';

// A production build.
await Bun.build({ entrypoints: ['./src/main.ts'], plugins: [depsPlugin] });
```

and `bun --preload @dunx/transform/preload src/main.ts`, which needs no config
file at all.

### `package.json`

```json
{
  "name": "my-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/main.ts",
    "start": "bun src/main.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@dunx/core": "^0.1.0",
    "@dunx/http": "^0.1.0",
    "@dunx/transform": "^0.1.0"
  },
  "devDependencies": {
    "@dunx/testing": "^0.1.0",
    "@types/bun": ">=1.4.0",
    "typescript": "^5.7.0"
  },
  "engines": {
    "bun": ">=1.4.0"
  }
}
```

`"type": "module"` is required. Every dunx package is ESM only, and
without it `verbatimModuleSyntax` raises `TS1287` against ESM syntax.

`@dunx/transform` is a runtime dependency rather than a dev dependency because the
preload runs when you run the app. If you compile ahead of time with
`Bun.build({ plugins: [depsPlugin] })`, it becomes build-time only and can move.

`@dunx/testing` is a dev dependency. It is what `src/app.test.ts` uses.

`dev` is `--watch`, which restarts the process on a change. `--hot` swaps modules
in place, but a container is built once at boot. The old providers would still
hold the socket the new ones are trying to bind.

### Keep every `@dunx/*` on the same version

The scaffold already does this, and it matters when you add a package by hand
later.

dunx releases in lockstep: every package shares one version and ships together,
even the ones a release did not touch. The packages peer-depend on each other by
caret range, so mixing minors resolves to a graph that warns on install:

```
warn: incorrect peer dependency "@dunx/http@0.2.0"
```

That happens when a lockfile already has an entry satisfying your range. Adding
`@dunx/auth` to an app pinned at `^0.2.0` can resolve auth to 0.2.5 and leave the
rest at 0.2.0, and `@dunx/auth@0.2.5` peers on `@dunx/http@^0.2.5`.

The warning is the good case. The bad one is **two copies of `@dunx/core` in one
tree**, which breaks dependency injection. A token _is_ a class object, so two
copies are two different classes. A provider bound against one is invisible to a
resolution against the other. The error says nothing is bound, from somewhere
unrelated to the version mismatch.

So when you add a package, match the version to the ones already installed:

```bash
bun add @dunx/auth@$(bun pm pkg get dependencies.@dunx/core --workspaces=false | tr -d '"^')
```

Or edit the manifest so every `@dunx/*` range reads the same, and reinstall.

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "lib": ["ESNext"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["bun"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"],
  "exclude": ["node_modules"]
}
```

**Do not enable `experimentalDecorators` or `emitDecoratorMetadata`.** dunx uses
TC39 standard decorators, and those flags change decorator semantics under you.

`moduleResolution: nodenext` is why relative imports carry a `.js` extension:
`import { AppModule } from './app.module.js'`. The file on disk is `.ts`. The
specifier is what the emitted declaration would carry, and an extensionless one
fails to resolve for consumers on `node16` or `nodenext`. Under this setting it
is a compile error.

`verbatimModuleSyntax` is why type-only imports must say so: `import type { Input }`.
It is also, indirectly, a DI hazard, and [Providers](./03-providers.md) covers
it: a constructor parameter whose type came in through a type-only import has no
runtime value to record, so the container cannot resolve it.

### `src/main.ts`

```ts
import { HttpFactory } from '@dunx/http';
import { AppModule } from './app.module.js';

const app = await HttpFactory.create(AppModule);
app.enableShutdownHooks();

const url = await app.listen(3000);
console.log(`listening on ${url}greetings`);

await app.closed;
```

Four lines of real work.

`HttpFactory.create(AppModule)` builds the container from the root module's import
graph, resolves every provider, awaits every async factory, runs every `onInit`,
then discovers each controller's routes and rejects any collision. It does not
bind a port. There is no separate `init()` step: resolution is eager, so an app
that exists is an app that booted.

`app.enableShutdownHooks()` registers `SIGTERM` and `SIGINT` handlers. Pass your
own list to change that. On a signal, the server stops first, then every provider
with an `onShutdown` method runs in reverse construction order.

`app.listen(3000)` builds the `Bun.serve` route table and binds. This is the
point of no return: `setGlobalPrefix`, `use`, `set` and `enableCors` all throw
afterwards, since the route table and the middleware chain are folded into one
closure per route when the server binds.

It returns the URL with a trailing slash, so the log line concatenates
`greetings` directly.

`await app.closed` holds the process. The promise resolves once shutdown has
finished, whoever triggered it.

### `src/app.module.ts`

```ts
import { Module } from '@dunx/core';
import { GreetingsController } from './greetings.controller.js';
import { GreetingsService } from './greetings.service.js';

@Module({
  controllers: [GreetingsController],
  providers: [GreetingsService],
})
export class AppModule {}
```

`@Module` is a marker. It writes its options onto the class under
`Symbol.for('dunx.module')` and the class is never instantiated. `controllers` and
`providers` are registered identically; the split exists so the HTTP adapter knows
which constructed instances to scan for routes.

Note that a bare class in either list is shorthand for binding it to itself. There
is no `provide(GreetingsService, { useClass: GreetingsService })` to write for the
ordinary case. [Modules](./04-modules.md) covers `imports`, why there is no
`exports`, and how ordering works.

### `src/greetings.service.ts`

```ts
import { Logger, type OnInit } from '@dunx/core';

export class GreetingsService implements OnInit {
  #greeted = 0;

  constructor(private readonly logger: Logger) {}

  onInit(): void {
    this.logger.info('greetings ready');
  }

  greet(name: string): { greeting: string; served: number } {
    this.#greeted++;
    return { greeting: `hello, ${name}`, served: this.#greeted };
  }
}
```

A plain class. No decorator, no registration boilerplate. Listing it in a module's
`providers` is what makes it injectable.

`Logger` in the constructor is the entire dependency injection story. Nothing in
this app bound `Logger` and it still resolves. `AppFactory.create` offers a
default binding for `Logger` and `RequestContext` after every module's. A module
that binds either one wins, and an app that binds neither still gets one.

The default is `ConsoleLogger`, which writes one JSON line per entry and reaches
for no dependency. It performs no sanitizing, masking or rotation, so swapping in
`@dunx/infra/logger` earns its place later.

`Logger` is an `abstract class` rather than an interface. The transform records
constructor parameter _types_, and an interface has no runtime value to record,
so an interface in that position would be a boot error at the injection site.

`implements OnInit` is structural. The container checks for an `onInit` method by
shape, so the `implements` clause is only there to make TypeScript check the
signature for you. `onInit` runs after the whole graph is constructed, in
dependency order.

### `src/greetings.controller.ts`

```ts
import { Controller, Get, type Input, type RouteSchemas } from '@dunx/http';
import { GreetingsService } from './greetings.service.js';

@Controller('greetings')
export class GreetingsController {
  constructor(private readonly greetings: GreetingsService) {}

  @Get('/')
  index(): { routes: readonly string[] } {
    return { routes: ['GET /greetings', 'GET /greetings/:name'] };
  }

  @Get('/:name')
  one(input: Input<RouteSchemas>): { greeting: string; served: number } {
    return this.greetings.greet(input.req.params['name'] ?? 'world');
  }
}
```

A controller is a provider with routes on it, and `GreetingsService` in the
constructor is resolved exactly the way the service's own `Logger` was.

Returning a plain object is enough. `@dunx/http` wraps it in `Response.json()`.
There is no `res` to forget to send, and returning a `Response` yourself passes
through untouched when you need the escape hatch.

`@Get('/:name')` declares no schemas, so the path parameter stays on
`input.req.params` as a string. `noUncheckedIndexedAccess` is why the `?? 'world'`
is there. Declaring a `params` schema is what makes it typed and coerced, and
[Controllers](./05-controllers.md) shows that.

`Input<RouteSchemas>` is the annotation for a route with no options at all. You
could also take no parameter. What you cannot do is leave the parameter
unannotated: a standard method decorator can check a handler's input type but
cannot contextually type an unannotated one, so an unannotated parameter is
`TS7006`. The reasoning, and the measurement behind it, are in
[Controllers](./05-controllers.md).

### `src/app.test.ts`

```ts
import { describe, expect, test } from 'bun:test';
import { createTestServer } from '@dunx/testing';
import { AppModule } from './app.module.js';

describe('minimal', () => {
  test('serves the greeting', async () => {
    const server = await createTestServer({ modules: [AppModule] });

    const { status, body } = await server.json<{ greeting: string }>(
      'greetings/ada',
    );

    expect(status).toBe(200);
    expect(body.greeting).toBe('hello, ada');
    await server.close();
  });
});
```

`createTestServer` boots the real application behind a real `Bun.serve` on port 0.
Nothing is faked. `Bun.serve` binds in about a millisecond, and a fake would only
be able to prove the parts of the request path dunx wrote rather than the parts
Bun owns: routing, params, method dispatch, upgrades.

`modules` takes one module or several; they become the `imports` of one synthetic
root, so you do not have to write a fixture module. Request logging is off unless
you ask for it, because a suite printing one JSON line per assertion helps nobody.

`server.json(path)` returns `{ status, headers, body }` in one await. `server.request()`
gives you the raw `Response` for bytes, HTML or a header assertion. `server.close()`
is `app.shutdown()`: it stops the server, then tears the container down.

### `AGENTS.md` and `CLAUDE.md`

`AGENTS.md` states this app's layout, its commands, and the rules dunx fails at boot
over: no `@Injectable()` to add, `.js` on relative imports, a `import type` at an
injection site being an error rather than an `undefined`. A composed app also lists
the features it carries and the services they want running.

`CLAUDE.md` is four lines pointing at it, so both filenames find the same
instructions and there is one file to edit.

Neither restates the framework. They link
[setup.md](https://petarzarkov.github.io/dunx/setup.md) and
[llms.txt](https://petarzarkov.github.io/dunx/llms.txt), which are served from the
documentation site and move with each release.

## Run it

```bash
cd my-api
bun install
bun run dev     # or `bun run start`, which does not watch
```

```
{"level":"info","message":"greetings ready", ...}
listening on http://localhost:3000/greetings
```

```bash
curl localhost:3000/greetings/ada
```

```json
{ "greeting": "hello, ada", "served": 1 }
```

```bash
bun test
```

## Add a route

Give the existing route a validated parameter. Add zod:

```bash
bun add zod
```

Then declare the schema and annotate the handler with it:

```ts
import { Controller, Get, type Input, type RouteSchemas } from '@dunx/http';
import { z } from 'zod';
import { GreetingsService } from './greetings.service.js';

const oneGreeting = {
  params: z.object({ name: z.string().min(1).max(40) }),
} as const satisfies RouteSchemas;

@Controller('greetings')
export class GreetingsController {
  constructor(private readonly greetings: GreetingsService) {}

  @Get('/:name', oneGreeting)
  one(input: Input<typeof oneGreeting>): { greeting: string; served: number } {
    return this.greetings.greet(input.params.name);
  }
}
```

`input.params.name` is now a `string` the schema has already checked, and the
`?? 'world'` is gone because the field cannot be missing. A request that fails the
schema never reaches the handler; it gets a 400 whose body carries every issue.

`as const satisfies RouteSchemas` is the convention for a hoisted options object.
`satisfies` checks the shape without replacing the type, so a misspelled field is
caught at the declaration. What you must not write is
`const oneGreeting: RouteSchemas = { ... }`: that annotation makes `params`
optional, `Input<typeof oneGreeting>` degrades to bare `{ req }`, and every
handler loses its typed input.

## Add a service

A second provider, injected into the first. No annotation anywhere:

```ts
// src/audit.service.ts
import { Logger } from '@dunx/core';

export class AuditService {
  readonly seen: string[] = [];

  constructor(private readonly logger: Logger) {}

  record(name: string): void {
    this.seen.push(name);
    this.logger.info('greeted', { name, total: this.seen.length });
  }
}
```

```ts
// src/greetings.service.ts
import { AuditService } from './audit.service.js';

export class GreetingsService {
  constructor(private readonly audit: AuditService) {}

  greet(name: string): { greeting: string } {
    this.audit.record(name);
    return { greeting: `hello, ${name}` };
  }
}
```

```ts
// src/app.module.ts
@Module({
  controllers: [GreetingsController],
  providers: [GreetingsService, AuditService],
})
export class AppModule {}
```

Order inside `providers` does not matter. The container resolves dependencies
recursively, so `AuditService` is built before `GreetingsService` regardless of
where it appears in the list. What order does control is teardown, and
[Modules](./04-modules.md) covers that.

Forget to list `AuditService` and it still works: every class is injectable by
default and an unbound constructor self-binds.

That convenience has two sharp edges. A typo in a module's `providers` list goes
uncaught, and an abstract class that is injected but never bound gets constructed
into a useless object rather than erroring.
[Providers](./03-providers.md) covers both.

## Next

[Providers](./03-providers.md) for how injection actually works and every shape of
`provide()`. [Modules](./04-modules.md) for composition, ordering and dynamic
modules. [Controllers](./05-controllers.md) for routing, validation and errors.

The four example applications in the repository are a ladder:
[`examples/minimal`](../../examples/minimal) is this app,
[`examples/databases`](../../examples/databases) sets up SQLite, Postgres and
MySQL, [`examples/testing`](../../examples/testing) covers overrides and guards,
and [`examples/full`](../../examples/full) is every package in one long-running
service.
