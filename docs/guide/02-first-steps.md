# First steps

This page scaffolds an application, explains every file in it, and then adds a
route, a service and a test. It assumes Bun 1.3 or newer and nothing else.

## Scaffold

```bash
bunx @dunx/create-app my-api
```

```
Created my-api in my-api/
  10 files from the minimal template

Next:
  cd my-api
  bun install
  bun run start
```

The generator takes the target directory as its only positional argument, plus
these flags:

| Flag                | Effect                                                      |
| ------------------- | ----------------------------------------------------------- |
| `--name <name>`     | Package name for the app. Defaults to the directory's base  |
| `--with <a,b,c>`    | Features to compose the app from. See **Choosing features** |
| `--all`             | Every feature                                               |
| `--list`            | Print the features and exit                                 |
| `--template <name>` | `minimal`, which is what you get with no `--with`           |
| `--force`           | Write into a directory that already has files in it         |
| `--yes`, `-y`       | Take the default selection without prompting                |
| `--help`            | Print usage                                                 |

Run in a terminal with nothing but a directory name and it asks which features you
want; answer with an empty line for the minimal template. Piped, or in CI, it never
prompts.

The package name is validated against npm's rules before anything is written, so
`bunx @dunx/create-app My-API` fails immediately with a message telling you to
pass `--name`, rather than producing a directory whose `bun install` fails later.
Refusing to write into a non-empty directory without `--force` is the other guard.

Every `@dunx/*` version in the generated manifest is resolved at run time from the
version of `@dunx/create-app` doing the scaffolding. The packages version in
lockstep, so the right version to install is whatever generated the app, and the
template never goes stale between releases.

## Choosing features

The minimal template is five files and one route, which is the right place to read
from and a thin place to start from. Anything more is composed:

```bash
bunx @dunx/create-app my-api --with users,openapi,http
```

```
Created my-api in my-api/
  28 files, 4 features: openapi, http, database, users
  database came along as requirements
```

`bunx @dunx/create-app --list` prints the current set:

| Feature      | What arrives                                                     | Pulls in            |
| ------------ | ---------------------------------------------------------------- | ------------------- |
| `notes`      | CRUD routes with zod validation. The smallest real feature       |                     |
| `openapi`    | OpenAPI 3.1 from the routes' own schemas, plus the explorer page |                     |
| `http`       | CORS, a request-logging middleware and error mapping             |                     |
| `guards`     | `@Roles` and `@Public`, and a protected controller               |                     |
| `database`   | drizzle over `bun:sqlite`, with a schema, seeds and migrations   |                     |
| `users`      | A repository, a service and validated routes over the database   | `database`          |
| `auth`       | better-auth mounted, with `SessionGuard` and an audit trail      | `database`          |
| `cache`      | `Bun.RedisClient` behind a session store                         |                     |
| `websockets` | A `@Gateway` with `@OnMessage`, `PubSub` and a Redis relay       |                     |
| `images`     | `Bun.Image` resizing and format conversion behind a route        |                     |
| `files`      | Uploads and downloads on `Bun.file`                              |                     |
| `jobs`       | bullmq queues and a worker, over `Bun.RedisClient`               | `images`            |
| `health`     | One endpoint reporting which parts are live and which degraded   | `cache`, `database` |

Requirements come along automatically, and the order they are imported in is
construction order, so a database is built before the feature that reads it and torn
down after it. `cache`, `websockets` and `jobs` want a Redis or Valkey; each reports
itself degraded rather than failing the boot, so the app still starts without one.

### Where the code comes from

Every feature directory is copied out of dunx's own
[`examples/full`](https://github.com/petarzarkov/dunx/tree/main/examples/full) - the
service CI builds, typechecks, tests and tours on every push. That is the point:
starter code nobody runs rots, and a byte-for-byte parity test fails the moment a
copy drifts from the example.

What cannot be copied is the wiring. `app.module.ts`, `config.ts`, `bootstrap.ts` and
`main.ts` name every feature at once in the full example, so those four are
**generated** for the selection - the config carries only the variables your features
actually read, and the manifest only the dependencies they need. CI scaffolds every
feature alone, the whole set, and the combinations with something to get wrong, then
typechecks each one.

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

This is the only setup dunx asks for, and it is worth understanding rather than
copying.

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

**What breaks without it.** Not a silent `undefined`. The container compares the
recorded dependency count against `Function.prototype.length`, which still reports
the declared parameter count after TypeScript's parameter properties are compiled
away. Zero recorded dependencies plus a non-zero arity can only mean the plugin
never saw the file, so boot fails carrying the fix:

```
GreetingsService declares 1 constructor parameter(s) but no dependencies were
recorded for it, so @dunx/transform did not transform GreetingsService. Register
the plugin, then retry:

  # bunfig.toml
  preload = ["@dunx/transform/preload"]

  [test]
  preload = ["@dunx/transform/preload"]
```

There are no false positives here. A constructor whose parameters all have
defaults has `length === 0` and is genuinely callable with no arguments; a class
bound with `useValue` is never constructed; and the transform only ever writes a
record whose length equals the parameter count, so a present record is never
empty.

You may be wondering why `@dunx/core` does not just register the plugin when it is
imported. Two reasons, and both are fatal. It would make DI import-order
dependent, because Bun's `onLoad` only affects modules loaded after registration
and static imports evaluate depth-first in source order, so
`import { AppFactory } from '@dunx/core'` before your module would work and the
reverse order would silently skip the transform. That is precisely the
"`reflect-metadata` must be the first import" fragility dunx exists to avoid. It
would also cost `@dunx/core` its empty dependency list, since every production
deploy would then carry a Rust parser to run code that was already transformed at
build time.

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
    "@types/bun": ">=1.3.0",
    "typescript": "^5.7.0"
  },
  "engines": {
    "bun": ">=1.3.0"
  }
}
```

`"type": "module"` is required, not stylistic. Every dunx package is ESM only, and
without it `verbatimModuleSyntax` raises `TS1287` against ESM syntax.

`@dunx/transform` is a runtime dependency rather than a dev dependency because the
preload runs when you run the app. If you compile ahead of time with
`Bun.build({ plugins: [depsPlugin] })`, it becomes build-time only and can move.

`@dunx/testing` is a dev dependency and is what `src/app.test.ts` uses.

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
tree, which breaks dependency injection outright**: a token _is_ a class object, so
two copies are two different classes, and a provider bound against one is invisible
to a resolution against the other. The error you get says nothing is bound, from
somewhere unrelated to the version mismatch.

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

What is not here matters as much as what is. There is no `experimentalDecorators`
and no `emitDecoratorMetadata`. dunx uses TC39 standard decorators, which need
neither, and adding them changes decorator semantics under you.

`moduleResolution: nodenext` is why relative imports in the generated source carry
a `.js` extension: `import { AppModule } from './app.module.js'`. The file on disk
is `.ts`; the specifier is what the emitted declaration would carry, and an
extensionless one fails to resolve for consumers on `node16` or `nodenext`. Under
this setting it is a compile error rather than someone else's problem.

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
bind a port. There is no separate `init()` step, because resolution is eager: an
app that exists is an app that booted.

`app.enableShutdownHooks()` registers `SIGTERM` and `SIGINT` handlers. Pass your
own list to change that. On a signal, the server stops first, then every provider
with an `onShutdown` method runs in reverse construction order.

`app.listen(3000)` builds the `Bun.serve` route table and binds. This is the point
of no return: `setGlobalPrefix`, `use`, `set` and `enableCors` all throw after it,
because the route table and the middleware chain are folded into one closure per
route when the server binds, so a late call could only ever be a silent no-op. It
returns the URL, with a trailing slash, which is why the log line concatenates
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
this app bound `Logger`, and it still resolves: `AppFactory.create` offers a
default binding for `Logger` and `RequestContext` after every module's, so a
module that binds either one wins and an app that binds neither still gets one.
The default is `ConsoleLogger`, which writes one JSON line per entry and reaches
for no dependency. It does not sanitize, mask or rotate, which is what makes
swapping in `@dunx/infra/logger` worth doing later.

`Logger` is an `abstract class` rather than an interface, and that is deliberate.
The transform records constructor parameter _types_, and an interface has no
runtime value to record, so an interface in that position would be a boot error at
the injection site.

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

## Run it

```bash
cd my-api
bun install
bun run start
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

Forget to list `AuditService` and it still works, because every class is
injectable by default and an unbound constructor self-binds. That convenience has
a sharp edge worth knowing about now: it means a typo in a module's `providers`
list is not caught, and it means an abstract class that is injected but never
bound gets constructed into a useless object rather than erroring.
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
