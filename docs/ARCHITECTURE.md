# dunx — Architecture

A Bun-native DI framework with NestJS-shaped ergonomics and none of the Nest
runtime. Standard (TC39) decorators, no `reflect-metadata`, no `tsyringe`, no
per-request container work.

## Why this exists

Elysia and Hono own Bun's web-framework space and are mature. Neither offers
dependency injection, modules, or class-based controllers, and Elysia's chained
builder API is precisely what NestJS refugees bounce off. That gap is the whole
product. dunx should stay a **DI + structure** framework that happens to serve
HTTP — not drift into a general web framework.

## Verified constraints

These were measured on Bun 1.3.14, not assumed. They drive most decisions below.

**Bun already has the router.** `Bun.serve({ routes })` handles path params,
per-method dispatch, static `Response` values, and 404-on-method-miss in native
Zig:

```
param route: 200 { id: "42" }   static route: 200 ok   unmatched method: 404
```

There is no reason to build a radix tree in JavaScript. dunx's job is to _emit_
the `routes` object at boot and hand it to Bun.

**`emitDecoratorMetadata` is lossy.** With `experimentalDecorators` +
`emitDecoratorMetadata`, `constructor(db: Db, cache: Cache, n: number)` yields:

```
paramtypes: [ "Db", "Object", "Number" ]
```

An interface degrades to `Object`, a primitive to `Number`. Constructor
injection therefore _requires_ `@Inject(TOKEN)` for everything that isn't a
class — Nest's worst ergonomic wart, inherited on day one.

**Standard decorators + `inject()` work today, zero dependencies.** Route
metadata collection and a full singleton graph both run under TC39 decorators
with no polyfill and no `experimentalDecorators`.

## The decorator dialect decision

`tsyringe` and Nest-style constructor injection are locked to legacy
`experimentalDecorators` **permanently**: TC39 standard decorators have no
parameter decorators, so `constructor(@inject(X) x: X)` has no migration path.
Building a new framework on the dialect TypeScript is walking away from, in
order to buy a lossy metadata table you then work around, is a bad trade.

dunx uses **standard decorators only**. The root `tsconfig.json` must not set
`experimentalDecorators` or `emitDecoratorMetadata`.

## Core primitives (`@dunx/core`)

Four exports. There is no `@Injectable()` — with `inject()` every class is
injectable by default.

| Primitive                                              | Purpose                                                 |
| ------------------------------------------------------ | ------------------------------------------------------- |
| `inject<T>(token): T`                                  | Resolve in a field initializer. Always synchronous.     |
| `token<T>(name)`                                       | Opaque token for interfaces, config objects, primitives |
| `provide(token, {useClass \| useValue \| useFactory})` | Binding, including async factories                      |
| `defineModule({controllers, providers, middleware})`   | Plain object — **not** a decorator                      |

```ts
@Controller('users')
export class UsersController {
  private users = inject(UsersService); // inferred, no token
  private cfg = inject(ConfigToken); // interfaces work fine
}
```

### Resolution mechanism

A module-level `currentInjector` is set around each `new Klass()`. Field
initializers run synchronously inside the constructor, so there is no async gap
and no `AsyncLocalStorage` cost. Calling `inject()` outside construction throws
with a clear message.

### Eager-only, no lazy resolution

`app.init()` topologically instantiates every provider and awaits async
factories before the server binds. Wiring errors surface at boot, not at first
request. This is what lets `inject()` stay synchronous: by the time any
constructor runs, every async provider is already resolved.

### Singleton lifetime only

Request-scoped DI is Nest's single biggest source of complexity and per-request
cost. Per-request state is passed as an explicit `ctx` argument instead.
Request-scoped _context_ (logging correlation and similar) stays a separate
`AsyncLocalStorage` concern that never touches the container.

### Cycle detection

A `building` set tracks in-flight construction and throws with the full cycle
path. Without it, a field-initializer cycle is an unbounded recursion with an
unreadable stack.

## Modules are data, not decorators

`defineModule()` returns a plain object. No per-module DI subgraph, no
`imports`/`exports`/`providers` visibility rules, no circular-module errors. The
container is flat; modules only group registrations.

This is the largest deliberate divergence from Nest and the first thing users
will notice. It should be loud in the README.

## One extension point, not five

Nest has middleware, guards, interceptors, pipes, and filters. dunx has:

```ts
type Middleware = (
  req: BunRequest,
  next: () => Promise<Response>,
) => Promise<Response>;
```

Guards are middleware that throw. Interceptors wrap `next()`. Pipes become
schema validation in the route options. Filters become one error mapper. Chains
compose into a single closure per route **at boot** — no per-request array
iteration.

## Params without parameter decorators

Standard decorators have no parameter decorators, so `@Body()` / `@Query()` are
off the table. Schemas move onto the route decorator:

```ts
@Post('/', { body: CreateUser, query: Paging })
create(req: BunRequest<'/users'>, input: { body: CreateUser; query: Paging }) {}
```

Validation targets the **Standard Schema** spec (`~standard.validate`), so
Zod 4, Valibot, and ArkType all work with zero dependencies in `@dunx/*`.

## HTTP adapter (`@dunx/http`)

Boot sequence:

1. Collect controllers from modules
2. Read route metadata
3. Join controller prefix + method path, normalize
4. **Detect collisions and throw** — Bun silently lets one route win
5. Build the `routes` object; each handler is a closure over the
   already-constructed instance and its bound method
6. Hand to `Bun.serve`

Per request the framework does exactly four things: validate declared schemas,
call the method, pass a `Response` through or wrap the return in
`Response.json()`, and map thrown errors. No lookup, no DI, no metadata read.

## Metadata storage — open risk

`ctx.metadata` requires `Symbol.metadata` to be defined, which reintroduces the
exact "must be the first import" fragility we are escaping from
`reflect-metadata`. It also inherits through the prototype chain, so a
subclassed controller silently absorbs its parent's routes.

Preferred alternative: method decorators push into a module-level pending array
that the class decorator drains into a `WeakMap` keyed by the class. Decorator
evaluation is synchronous and lexically ordered per class, so this is safe,
needs no polyfill, and has no inheritance leak.

Treat `ctx.metadata` as the fallback, not the default.

## Build & packaging

Bun-only, so the ESM/CJS/types triple build is wasted work.

- **ESM only.** One `tsconfig.json` per package.
- `Bun.build` emits JS: `target: 'bun'`, `format: 'esm'`,
  `packages: 'external'` (relative imports bundle, dependencies stay external),
  `sourcemap: 'linked'`.
- `tsc --emitDeclarationOnly` emits the `.d.ts` tree. Bun has no `--dts`.
- Relative imports in source **must** carry a `.js` extension. `tsc` copies the
  specifier verbatim into `.d.ts`, and an extensionless specifier fails to
  resolve for consumers on `moduleResolution: node16`/`nodenext`.
- `"type": "module"` is required in every package manifest. Without it,
  `verbatimModuleSyntax` reports `TS1287` against ESM syntax.

Both halves run from the shared `scripts/build-package.ts`, so there is one
implementation for every package.

## Scaffolder (`create-app`)

`@dunx/create-app` gets all three invocations from one package name:

```
bun create @dunx/app my-app
npm  create @dunx/app my-app
bunx @dunx/create-app my-app
```

Zero dependencies, Node-targeted (so `npx` works for people who have not
installed Bun yet, and can then tell them to), templates as directories with
token replacement. No network, no degit.

## Roadmap

Exit criteria are written as individually checkable statements on purpose.
`/whats-next` reads this section to place the work and to fill in `HANDOFF.md`'s
next steps, so a criterion that cannot be verified against the tree by inspection
is a criterion that gets reported wrong. Keep them mechanical.

### Phase 1 — DI proven end to end

Ship `@dunx/core` and a single `examples/playground` app that boots a fully
dependency-injected application graph **with no HTTP at all**.

Keeping HTTP out is the point. If the example can only be evaluated by curling
it, ergonomic problems in the container hide behind routing. A no-HTTP example
forces `inject()`, tokens, async factories, and shutdown ordering to stand on
their own.

Exit criteria:

- `inject()` resolves classes and tokens, with inference and no manual generics
- `provide()` covers `useClass`, `useValue`, and async `useFactory`
- `defineModule()` composes across at least two feature modules
- A circular dependency throws a readable error naming the full cycle
- `onInit` / `onShutdown` run in dependency order; `SIGTERM` closes cleanly
- Resolving a provider twice returns the same instance
- The example runs via `bun start`, exits 0, and CI asserts that

The playground is one app that grows through the phases, not a new example per
phase.

### Phase 2 — HTTP

`@dunx/http`, the `Bun.serve` adapter, the middleware chain, the error mapper,
and route-collision detection. The playground grows a controller; its Phase 1
assertions keep passing unchanged.

### Phase 3 — Validation

Standard Schema wiring and typed route input. Gated on the inference spike
below.

### Phase 4 — Testing & scaffolder

`@dunx/testing` (`createTestApp({ modules, overrides })`, real server on port 0)
and `@dunx/create-app`.

### Phase 5 — OpenAPI

Separate package, peer dependencies. Deferred because Standard Schema v1 has no
JSON Schema export, so this needs a per-library adapter (Zod 4's
`z.toJSONSchema`, etc.).

## Spikes to resolve before Phase 2

Both are roughly an hour and both change the public API shape, so they belong
before the code they gate — not after. Run them through `/spike`: measure on real
Bun, record the result under **Verified constraints** above, then delete the item
from this list.

1. **Route input inference.** Does `@Post(path, { body: Schema })` cleanly
   constrain the method signature through the method decorator's generic? The
   fallback is an explicit `InferInput<typeof opts>` annotation, which works but
   is uglier. Gates Phase 3.
2. **Metadata storage.** Confirm the `WeakMap` pending-drain approach against
   `Symbol.metadata` availability in Bun, including subclassed controllers.
   Gates Phase 2.
