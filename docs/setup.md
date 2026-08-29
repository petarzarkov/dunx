# Setting up dunx

Instructions for an agent setting up a dunx application. Served raw at
<https://petarzarkov.github.io/dunx/setup.md>, so it can be fetched and followed
without cloning anything.

dunx is a Bun-native dependency injection framework: modules, controllers,
providers and lifecycle hooks, on `Bun.serve`. Constructor injection needs no
annotation. Requires **Bun 1.4 or newer** and no other runtime.

## Scaffold, or wire it by hand

`bunx @dunx/create-app` writes a working app. With a terminal attached it opens a
list of features: space toggles one, Enter takes the selection, and the list says
which entries your choices pull in. **Piped or in CI it asks nothing** and writes
the minimal template, so an agent or a script never blocks on it.

```bash
bunx @dunx/create-app my-api        # asks, then writes what you chose
bunx @dunx/create-app my-api --yes  # skips the questions: 12 files, one route
cd my-api && bun install && bun run dev
```

To choose features without a terminal, call `scaffold({ target, features })` from
`@dunx/create-app` rather than passing flags.

Composed apps carry a feature directory each, copied from dunx's own
`examples/full`. Every scaffolded app gets an `AGENTS.md` naming its layout and the
rules below; read it before editing the app.

The rest of this page is the manual path, for adding dunx to a project that already
exists.

## Install

```bash
bun add @dunx/core @dunx/http @dunx/transform
bun add -d @dunx/testing @types/bun typescript
```

Add packages per feature as you need them, from the table further down. All
`@dunx/*` packages version in lockstep: install the same version of each.

## `bunfig.toml`

```toml
# The one line that makes constructor injection work. The compiler plugin records
# each class's constructor parameter types so the container can resolve them.
# Without it, providers are built with no arguments and boot fails saying so.
preload = ["@dunx/transform/preload"]

[test]
preload = ["@dunx/transform/preload"]
```

Both sections are needed: `bun test` reads its own `preload`, and a suite without
it fails the same way the app does.

## `tsconfig.json`

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

Do not add `experimentalDecorators` or `emitDecoratorMetadata`. dunx uses TC39
standard decorators, which both flags change the meaning of.

## The four files of a working app

`src/greetings.service.ts` - a provider is a plain class:

```ts
import { Logger, type OnInit } from '@dunx/core';

/** A provider is a plain class. Listing it in a module's `providers` is what
 * makes it injectable; the container reads `Logger` off the constructor. */
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

`src/greetings.controller.ts` - a controller returns plain objects:

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

  // With no `params` schema declared, a path param stays a string.
  // `examples/full` shows the typed, coerced version.
  @Get('/:name')
  one(input: Input<RouteSchemas>): { greeting: string; served: number } {
    return this.greetings.greet(input.req.params['name'] ?? 'world');
  }
}
```

`src/app.module.ts` - `controllers` get routes, `providers` do not:

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

`src/main.ts` - the entry point:

```ts
import { HttpFactory } from '@dunx/http';
import { AppModule } from './app.module.js';

const app = await HttpFactory.create(AppModule);
app.enableShutdownHooks();

const url = await app.listen(3000);
console.log(`listening on ${url}greetings`);

await app.closed;
```

## Verify

```bash
bun src/main.ts &
curl -s localhost:3000/greetings/ada     # {"greeting":"hello, ada","served":1}
```

A test needs no running server of its own:

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

`createTestServer` binds a real `Bun.serve` on port 0. `createTestApp` builds the
container without a server, and both take `overrides` to replace a provider in
place.

## Rules that produce a boot error when broken

- **No `@Injectable()`, no `@Inject()`.** Being listed in a module's `providers` is
  what makes a class injectable. TC39 standard decorators have no parameter
  decorators, so `@Inject()` cannot exist. For a value with no constructor
  parameter to hang off, use `inject(Token)` in a field initializer.
- **No `reflect-metadata`, no `tsyringe`.** Nothing imports either.
- **A constructor parameter whose type is erased fails at boot, naming the
  parameter.** An interface, a primitive, a union, a class type parameter or a
  `import type` at an injection site all record as `unresolved`. Inject a class, and
  drop `type` from the import.
- **Relative imports carry `.js`**, matching the emitted specifier under
  `nodenext`: `'./greetings.service.js'`, never `'./greetings.service'`.
- **A module's `exports` is its public surface.** The container is scoped per
  module, so a provider another module injects has to be exported by the module that
  declares it. Absent `exports` means nothing is exported; `global: true` publishes
  a module's exports app-wide.
- **`bun` only.** No `npm`, `npx`, `yarn` or `pnpm`; run tools with `bunx`.

## Configuration

One validation function, raw env in and a shaped object out. Whatever it throws is
what boot fails with.

```ts
import { ConfigModule, ConfigService } from '@dunx/core';
import { z } from 'zod';

const schema = z.object({ PORT: z.coerce.number().default(3000) });
export type AppConfig = z.infer<typeof schema>;
export class AppConfigService extends ConfigService<AppConfig> {}

ConfigModule.forRoot({
  validate: (env) => schema.parse(env),
  as: AppConfigService,
});
```

Declare the subclass and pass it as `as`: without it, a factory annotating
`ConfigService<AppConfig>` is rejected, since the bare token carries no type
argument. Bun loads `.env` and `.env.local` on its own, so there is no loader and no
`dotenv`.

## Which package for what

| Need                             | Import                                                    |
| -------------------------------- | --------------------------------------------------------- |
| DI, modules, lifecycle, config   | `@dunx/core`                                              |
| Routes, middleware, guards, CORS | `@dunx/http`                                              |
| Websockets                       | `@dunx/http` - `@Gateway`, `@OnMessage`                   |
| Outbound HTTP with retries       | `@dunx/http/client`                                       |
| Database and migrations          | `@dunx/infra/db` - drizzle over `bun:sqlite` or `Bun.SQL` |
| Redis or Valkey                  | `@dunx/infra/redis` - `Bun.RedisClient`                   |
| Queues and workers               | `@dunx/infra/queue` - bullmq                              |
| Cron and intervals               | `@dunx/infra/schedule`                                    |
| Uploads, downloads, images       | `@dunx/infra/files`, `@dunx/infra/images`                 |
| Structured logging               | `@dunx/infra/logger`                                      |
| OpenAPI 3.1 and Swagger UI       | `@dunx/openapi`                                           |
| Sessions and sign-in             | `@dunx/auth` - better-auth                                |
| Tests                            | `@dunx/testing`                                           |
| An ops page                      | `@dunx/dashboard`                                         |

Validation is Standard Schema, so zod, Valibot and ArkType all work with no adapter.
drizzle, better-auth, bullmq and zod are peer dependencies: install the ones the
features you use need.

## Reading an app you did not write

```bash
bunx @dunx/mcp ./src/app.module.ts
```

An MCP server over stdio answering what routes, providers, modules and gateways
exist, and which constructor parameters would fail to resolve. It reads the module
graph and never boots the app.

## More

- <https://petarzarkov.github.io/dunx/llms.txt> - every document, as raw markdown
- <https://petarzarkov.github.io/dunx/> - the guide, the API reference, benchmarks
- <https://github.com/petarzarkov/dunx/blob/main/docs/MIGRATION-FROM-NEST.md> -
  coming from NestJS
- <https://github.com/petarzarkov/dunx/tree/main/examples> - `minimal`,
  `databases`, `testing`, `full`
