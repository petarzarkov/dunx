# Agent tooling

An agent working in a dunx application spends most of its budget rediscovering
things the framework already knows: which routes exist, what validates a body, which
module bound a provider, why boot fails. `@dunx/mcp` answers those over the
[Model Context Protocol](https://modelcontextprotocol.io) so the agent can ask
instead of grepping.

```bash
bunx @dunx/mcp ./src/app.module.ts
```

## Wiring it into a client

```json
{
  "mcpServers": {
    "dunx": {
      "command": "bunx",
      "args": ["@dunx/mcp", "./src/app.module.ts"]
    }
  }
}
```

Point it at the file that declares your root module. There is no naming convention
to satisfy - `@Module` leaves a marker, so a module exported only by name is found on
its own, which is what `bunx @dunx/create-app` scaffolds. `default` and `root` win if
present, and `--export=<name>` settles a file that declares several. The path is
resolved with `Bun.resolveSync`, so anything `import` accepts works: a relative path
with or without `./`, an absolute one, an extensionless specifier, or a package name.

## The tools

| Tool             | Answers                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `dunx_overview`  | Counts, plus every constructor dependency whose type was erased. The cheapest first call                        |
| `dunx_routes`    | Every route: controller, handler, module, guards, `@Public()`/`@Roles()`, status, and which inputs it validates |
| `dunx_providers` | Every registration - controllers, gateways, `useClass`, `useValue`, `useFactory` - with its dependencies        |
| `dunx_gateways`  | Every websocket gateway, its path, and the handler each `@OnMessage` event lands on                             |
| `dunx_modules`   | The module graph in traversal order, and what each module contributes                                           |
| `dunx_openapi`   | The OpenAPI 3.1 document, with the real request and response JSON Schemas                                       |

Every tool takes optional filters and nothing else, so a caller that knows nothing
still gets a useful first answer:

```jsonc
{ "name": "dunx_routes", "arguments": { "method": "POST", "path": "/users" } }
{ "name": "dunx_providers", "arguments": { "unresolvedOnly": true } }
```

The filters exist because a large app's full route table is a lot of tokens to hand a
model that asked about one path. Omitting them means everything.

### Start with the overview

`dunx_overview` is the call worth making first. It says how big the app is and
whether it would boot, without returning the graph:

```json
{
  "modules": 23,
  "controllers": 12,
  "gateways": 1,
  "providers": 53,
  "routes": 40,
  "publicRoutes": 8,
  "guardedRoutes": 7,
  "unresolvedDependencies": []
}
```

`unresolvedDependencies` is listed rather than counted, because each entry is a boot
error naming a parameter. A constructor parameter whose type was erased - an
interface, a primitive, a union, a type-only import - is recorded by
`@dunx/transform` as `unresolved`, and that is the wart `emitDecoratorMetadata` has
and dunx does not. The `typeOnly` case is called out separately because it has a
one-line fix:

```json
{
  "provider": "ReportsService",
  "module": "ReportsModule",
  "unresolved": "private readonly config: AppConfig",
  "typeOnly": "AppConfig"
}
```

Drop the `type` from that import and it resolves.

### Which inputs, or which schemas

`dunx_routes` reports **that** a route validates its body, and by which Standard
Schema vendor. It does not report the schema:

```json
{
  "method": "POST",
  "path": "/api/users",
  "controller": "UsersController",
  "handler": "create",
  "module": "UsersModule",
  "public": false,
  "roles": ["admin"],
  "guards": ["SessionGuard"],
  "hidden": false,
  "validates": { "body": "zod" },
  "status": 201,
  "responses": [201, 422]
}
```

Turning a schema into JSON Schema is zod-specific work `@dunx/openapi` already does
properly, so `dunx_openapi` is where it lives - and that split is what keeps the
other five tools working in an app with no OpenAPI setup. `@dunx/openapi` is an
optional peer, loaded only when `dunx_openapi` is called.

## It reads the app. It never boots it.

This is the decision the package is built around.

`AppFactory.create()` instantiates every provider and awaits every async factory
before it returns - dunx has no lazy resolution, deliberately. So booting an app to
answer "what routes exist" would open database connections, start queue workers, bind
sockets and run every `onInit`. An agent asking a question about the code would be
running the code, with side effects, against whatever environment happened to be
configured.

Reading costs none of that. `discoverRoutes` and `discoverGateway` each walk a
prototype chain, and `Object.create(Controller.prototype)` is that chain with nothing
behind it: `instance.constructor` still resolves to the class, every method is still
reachable, and no constructor - or dependency of one - has to exist. The container
graph comes from the same functions the container itself reads it with:
`collectModules`, `readControllers`, `readDeps` and `describeToken`.

**What that rules out is runtime state.** The value of a config field, or whether the
database is reachable, is not answerable here. If one of those is ever genuinely
needed it belongs in a separately named tool whose description says it boots the app,
so the cost is visible at the call site rather than hidden inside every answer.

## What to ask it

The questions it answers better than a search:

- **"What is the unauthenticated surface?"** `dunx_routes` with `publicOnly`, which
  is `@Public()` resolved through class-level and method-level metadata rather than
  grepped for.
- **"Why does boot fail?"** `dunx_providers` with `unresolvedOnly`, which is the set
  of registrations that would throw, with the parameter named.
- **"Who binds this token?"** `dunx_providers` with `token`, which reports the module
  and the binding kind - a `useFactory` and a bare class look nothing alike in source
  and identical here.
- **"Which event does this websocket message land on?"** `dunx_gateways`, since
  `@OnMessage('say')` is a marker on a method and nothing in the path tells you.

And the one it deliberately cannot answer: **"is Redis up?"** That needs the app
running, and this never runs it.
