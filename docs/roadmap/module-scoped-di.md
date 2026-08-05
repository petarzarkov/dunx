# Module-scoped DI, `exports`, and `@Global()`

**P0, and the core of it is shipped** - scopes, `exports`, `global: true`,
module-scoped middleware, the `AsyncModuleConfig` imports field, and the error
messages, with all nine packages, both examples and the scaffolder migrated. What is
left is at the bottom under "Still open".

**A deliberate reversal**, requested directly: "a truly DI and IoC framework needs to
have this." The flat container and the absence of `exports` are dunx's largest
divergence from Nest, they are argued at length in
[architecture/dependency-injection.md](../architecture/dependency-injection.md) under
"Modules group registrations; they do not encapsulate", and **per-module subgraphs** is
currently listed in ROADMAP's Rejected section. All of that is now superseded.

Nobody is consuming dunx yet, so there is **no deprecation path to design and no
backwards compatibility to preserve**. That removes the single largest cost this change
would otherwise carry, and it is why it should happen now rather than after 1.0.

## The motivation is module-scoped middleware, not Nest parity

Worth stating first, because it decides the design. The ask is not "be like Nest"; it
is that a module should be able to provide middleware **for its own routes**, resolved
from **its own scope**. That is impossible today for a reason that is structural rather
than an oversight:

- Middleware is registered once, globally, in `HttpOptions.middleware`.
- Every provider lives in one flat container, so there is no "its own scope" to resolve
  from.

Scoped DI is what makes module-scoped middleware expressible. So the two ship together,
and if scoping landed without it the change would be Nest parity for its own sake.

## What flatness actually bought, so nothing is lost by accident

Each of these is load-bearing today and needs an answer, not a shrug.

| Property                                                  | Under scopes                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------- |
| Two modules binding one token is a **boot error**         | Becomes legal - that is the point. Replaced by narrower checks, below |
| `createTestApp({ overrides })` replaces **in place**      | Must now decide _which scope_ it replaces in                          |
| No "provider is not exported from module X" error exists  | It now exists. Its message quality is a deliverable, not a nicety     |
| Diamond imports register once; cycles terminate           | Unchanged: keyed on module reference, as now                          |
| Eager resolution, async factories settled before any ctor | Unchanged, per scope, in import order                                 |
| Resolution is one `Map.get` by token                      | Preserved by flattening visibility at boot - see "Cost"               |

## The model

Three concepts, and no more.

**A scope is a module.** Every module reference in the graph gets its own injector
holding the providers it declares. Two _different_ configurations of one module are two
scopes, which is consistent with today's per-reference deduplication.

**`exports` is visibility.** A module lists the tokens an importer may resolve.
Everything else it declares is private to it. `exports` accepts a token or a module
reference; a module reference re-exports whatever that module exports, which is how a
facade module (`InfraModule` re-exporting `DbModule`) stays possible.

**`global: true` publishes exports app-wide.** A global module's _exports_ land in one
global scope visible from every other scope, without being imported. Its private
providers stay private. This is what `Logger` and `RequestContext` become: core's
always-bound defaults move into the global scope instead of being appended to a flat
list.

A **field on `@Module`, not a second `@Global()` decorator.** Nest needs the decorator
because its metadata is decorator-only, and then needs a `global: true` field anyway for
`DynamicModule`, which is two spellings for one idea. dunx already configures modules
through an options object, so the field covers both static and configured modules with
one spelling. `@Global()` could be a one-line alias if the familiarity is worth it, but
it should not be the primary form.

### Resolution order

For a token requested while constructing a provider declared by module `M`:

1. `M`'s own providers.
2. The exports of the modules `M` imports, transitively through re-exports.
3. The global scope.
4. If the token is a **class** with no binding anywhere visible, self-bind it **into
   `M`'s scope**. This keeps today's "a class nobody listed is still resolvable"
   behaviour, and keeping it local rather than global is what stops an unlisted
   collaborator leaking between features.
5. Otherwise it is a resolution error. See "The error is the feature".

**Local shadows imported.** If `M` declares a token an import also exports, `M`'s wins.
That is the per-module rebinding this whole change exists to allow.

### Instance identity

A provider is a **singleton in the scope that declares it**. An importer resolving it
through `exports` gets that same instance rather than a copy - so `DbConnection`
exported by `DbModule` is one connection however many modules import it, which is the
only behaviour that could possibly be correct for a connection.

Two modules that each _declare_ the same class get two instances. That is the rebinding
capability, and it is also the sharpest new footgun: declaring `UsersService` in two
modules used to be a boot error and will now silently produce two of them. Covered
under "What replaces the duplicate check".

## Module-scoped middleware

The payoff, and the part with no Nest equivalent worth copying - Nest's
`configure(consumer)` plus `forRoutes()` is a second registration language, and dunx
does not need one because **a module already owns its controllers**.

```ts
@Module({
  controllers: [ReportsController, ExportsController],
  providers: [ReportsService, TenantGuard],
  middleware: [TenantGuard], // applies to this module's routes only
  exports: [ReportsService],
})
export class ReportsModule {}
```

`TenantGuard` is resolved from `ReportsModule`'s scope, so it can inject providers that
module keeps private. No `forRoutes('reports/*')`, no path matching, no second
vocabulary: the routes it applies to are the routes the module's controllers declare.

**One field, named `middleware`, not a `middleware` plus a `guards` array.** A guard in
dunx is middleware that throws - that is the "one extension point, not five" decision,
and it is the reason there is no interceptor, pipe or filter concept either. Adding a
second array here would reintroduce Nest's split at exactly the moment the rest of the
design is removing divergence for its own sake.

### The chain, outermost first

```
RequestLoggingMiddleware          (built in, unless disabled)
global middleware                 (the options provider)
  declaring module middleware     (that module's array, in order)
    @UseGuards on the controller
      @UseGuards on the method
        handler
```

There is no ancestor layer: a module's middleware applies to **its own** controllers and
to nothing it imports. So importing a module never changes the request path of the
importer's routes, which is the surprise this change exists to remove rather than
relocate. A module that wants to guard a sub-feature guards it where it is declared.

Two properties this has to keep, and both are already how `Middleware` works:

- **It is one nesting, not two mechanisms.** Every layer is the same `Middleware`
  interface wrapping `next()`, which is the "one extension point, not five" decision.
  Module scoping adds _where a layer comes from_, not a new kind of layer.
- **Order stays readable.** Within a module it is the array's order, and there is no
  cross-module ordering to reason about because there is no ancestor layer. No priority
  numbers - the lesson from `dunx-template`, where the dashboard had to precede
  `SessionGuard` and the audit stamp had to follow it, is that an ordered list a reader
  can see beats a number they have to collate across files.

The consequence to accept: a cross-cutting guard that really does apply everywhere stays
**global**, in the options provider, exactly as it is today. `SessionGuard` in
`dunx-template` is that case and should not move. What moves into a module is the
guard that only ever made sense for one feature - and the test of whether this design
paid off is that `dunx-template`'s `ThrottleGuard` and `AuditContextMiddleware` can
stop being app-level arrays.

## Circular module imports, and why `forwardRef` still never appears

The obvious worry: dunx rejects `forwardRef`, resolves eagerly, and a scoped container
makes visibility directional. So does `A imports B, B imports A` become a problem?

**No, and the reason is worth being precise about, because it is easy to attribute to
the wrong thing.** dunx does without `forwardRef` not because the container is flat but
because the dependency record is a **thunk**: `@dunx/transform` writes
`Symbol.for('dunx.deps')` as a function, and `readDeps` calls it _at resolution_, not at
class-definition time. That is what already makes a dependency declared later in a file,
or across a circular ES import, resolve. Nothing about scoping touches it.

So three separate cycles need separating, and only one of them is new.

### 1. Module import cycles - legal, unchanged

`collectModules` visits each module reference once, so the traversal terminates today
and will terminate identically. A cycle in `imports` is not a cycle in anything that has
to be computed in order, with one exception, next.

### 2. Re-export cycles - the one genuinely new case

`exports` accepting a module reference means an export set can depend on another export
set:

```ts
@Module({ imports: [B], exports: [B] })
class A {}
@Module({ imports: [A], exports: [A] })
class B {}
```

Computing "what does A export" now needs "what does B export" and vice versa. Naive
recursion stack-overflows.

**It is not a real cycle, though, and needs no user-facing concept to fix.** A module's
export set is the union of its own listed tokens plus the export sets of the modules it
re-exports, and union is **monotonic** - the set only grows. So:

1. Compute every module's **own** declared bindings. This depends on nothing and is
   always possible.
2. Compute export sets by iterating to a **fixed point**: repeat the union pass until no
   set changes. Monotonicity guarantees termination, in at most as many passes as there
   are modules. Collapsing strongly-connected components first is the same answer with
   fewer passes and is the optimisation, not the design.
3. Flatten each scope's lookup map from own bindings, imported export sets, and the
   global scope, local winning.

No `forwardRef`, no lazy module references, no new API. The cost is one extra pass over
a graph that is tens of nodes.

### 3. Provider cycles - still a boot error, deliberately

`P` in module A needs `Q` in module B, and `Q` needs `P`. That is a genuine
construction cycle and is already an error today: the `#building` stack throws with the
full path. **This must not change.** It is a bug in the app, not a pattern to support,
and `forwardRef` in Nest exists largely to paper over it.

The distinction to keep clear in the error message: a **module** cycle is fine, a
**provider** cycle is not, and someone hitting the second will assume they hit the
first. The message should say so explicitly, and name the provider path rather than the
module path.

### What this means for instantiation order

Today `collectModules` yields imports before importers, and that ordering is what
construction and reverse-order shutdown ride on. Under a module cycle that ordering is
undefined - so it must stop being what resolution depends on.

It already is not. `injector.resolve(token)` walks the **provider** dependency graph
recursively and constructs on demand; the module order only decides registration.
Keeping that property is the requirement: **resolution order comes from the provider
graph, module order only from the import graph.** Then a module cycle whose providers
have no cycle resolves fine, and `onInit` ordering and reverse-order shutdown keep
working because both key on construction order rather than module order.

## The error is the feature

`exports` reintroduces the single most complained-about error in the Nest ecosystem.
dunx's job is to make it the one place it is strictly better, and it can be, because it
knows the whole graph at boot:

```
Cannot resolve UsersRepository for ReportsService in module "ReportsModule".

UsersRepository is declared by module "UsersModule", which "ReportsModule" imports,
but "UsersModule" does not export it.

Fix one of:
  - add UsersRepository to UsersModule's `exports`
  - move UsersRepository into ReportsModule's `providers`
```

Every branch needs writing, and each is answerable from the graph:

| Situation                                    | The message must say                                        |
| -------------------------------------------- | ----------------------------------------------------------- |
| Declared by an imported module, not exported | which module, and the `exports` line to add                 |
| Declared somewhere not imported              | which module, and the `imports` line to add                 |
| Declared nowhere                             | that nothing binds it, and the nearest name if one is close |
| Exported by a module that is not global      | that `@Global()` or an explicit import is needed            |
| The consumer is a route handler              | the controller and method, not just the class               |

This is worth more engineering than the resolution itself. A scoped container whose
failure mode is a good error is a better framework; one whose failure mode is Nest's
`(?)` is a worse one.

## What replaces the duplicate check

Today any repeated token is a boot error naming both modules. That check cannot survive
intact, because repetition across scopes is now the feature. It splits into three:

1. **The same token twice in one module: still an error**, unchanged, and now with no
   ambiguity about which module to name.
2. **The same token declared by two modules: legal and silent.** This is rebinding.
3. **A token declared locally that an import also exports: legal, and warned once at
   boot**, listing the token, the declaring module and the shadowed one.

Point 3 is the open question. Silent shadowing is exactly how "my override is not being
used" happens, and a warning is cheap at boot. It is also noise if a codebase leans on
shadowing deliberately, so it may want to be opt-out. Decide before shipping, not
after.

## Overrides, and the test harness

`createTestApp({ modules, overrides })` currently replaces by token in one flat list,
and an override matching nothing is an error. Both survive with one addition:

```ts
overrides: [provide(Logger, { useValue: recording })]; // every scope
overrides: [provide(UsersRepository, { useValue: stub, in: UsersModule })]; // one
```

**Default to replacing in every scope that binds the token.** A test that stubs `Logger`
should not have to know how many scopes bind it, and the alternative - making the test
name a scope - pushes container topology into every suite. `in:` exists for the case
where two scopes genuinely bind the same token differently and the test means one.

"An override that replaced nothing is an error" gets more valuable here, not less: it is
what catches an override aimed at a token that has moved behind an `exports` boundary.

## Cost, and how resolution stays one lookup

Walking an ancestor chain per lookup would make every construction O(depth), and boot is
already the phase dunx spends in: the benchmark measures ~53 ms against raw
`Bun.serve`'s ~27 ms, and eager resolution plus route discovery is most of the gap.

**Flatten at boot.** After the graph is collected, compute for each scope one
`Map<token, binding>` holding its own providers plus everything visible through imports
and the global scope, with local winning. Resolution is then the same single `Map.get`
it is today, and the ancestor walk happens once per scope rather than once per lookup.

The measurable claims, which must be checked rather than assumed:

- **A boot-time regression is accepted**, decided explicitly: encapsulation is worth it.
  Still measure it with `tools/bench`'s `startup` scenario before and after, so the
  number is known rather than discovered later - today's figure is ~53 ms against raw
  `Bun.serve`'s ~27 ms.
- Request-path cost must not move at all. Nothing above touches the request path except
  module middleware, which is a longer chain only where a module declares one.

## Scope of the change

This is a core rewrite that reaches every package. Not a caveat - a plan item.

| Area                                        | What changes                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `core/src/di/injector.ts`                   | one injector becomes a scope with a parent chain and a flattened lookup map |
| `core/src/di/module.ts`                     | `ModuleOptions` gains `exports` and `middleware`; `@Global()` marker added  |
| `core/src/di/app.ts`                        | builds a scope per module rather than one flat registration pass            |
| `core/src/di/deps.ts` / `inject()`          | field-initializer `inject()` needs the ambient scope - see the hazard below |
| `http/src/server/factory.ts`                | route discovery must record the declaring module so its middleware applies  |
| `http/src/server/routes.ts`                 | the chain gains the module layers                                           |
| every `@dunx/*` module                      | must declare `exports`, or its consumers break                              |
| `@dunx/testing`                             | `in:` on overrides, and the multi-scope replacement                         |
| `@dunx/mcp` graph readers                   | `providersOf` / `modulesOf` must report scope and visibility                |
| `docs/architecture/dependency-injection.md` | the "do not encapsulate" section is rewritten, not amended                  |
| `dunx-template`, `examples/*`               | every module gains `exports`; feature guards move into their modules        |

**The `exports` sweep across nine packages is the largest mechanical piece.** Every
public token that consumers currently resolve out of the flat container needs listing:
`DbConnection` and the drizzle handle from `DbModule`, `RedisConnection` from
`RedisModule`, `JobPublisher` and `QueueOptions` from `QueueModule`, `Auth`,
`AuthContext` and `SessionGuard` from `AuthModule`, `Storage`, `Images`,
`OpenApiExplorer`, `HttpService`. Missing one is a consumer-facing break, so this wants
a test that asserts every package's documented public tokens are exported by the module
that binds them.

### One hazard worth deciding early

**`inject()` in a field initializer has no module context.** It runs during
construction, so the injector can resolve it from whatever scope is currently
constructing - the `#building` stack already tracks in-flight construction and is the
place to carry it. But `inject()` called anywhere else, including at module scope or
top level, has no ambient scope and must be a clear error rather than a silent global
lookup.

## Sequencing

1. **Scopes, `exports`, `@Global()`, flattened lookup, and the error messages.** Core
   only, with the existing suite green. The error-message table above is part of this
   step, not a follow-up.
2. **The `exports` sweep** across all nine packages, with the test that guards it.
3. **Module-scoped middleware** in `@dunx/http`, declaring-module-only.
4. **Overrides and `@dunx/testing`.**
5. **`@dunx/mcp` readers, the architecture doc rewrite, and the guide.**
6. **`dunx-template` and the examples**, which is also the acceptance test: a feature
   guard that lives in its feature module and injects that module's private providers.

Steps 1 and 2 are one release; nothing works between them.

## How this changes the other P0

[class-modules-and-opt-in-config](./class-modules-and-opt-in-config.md) is now second,
and two of its items change shape:

- **W1's `middleware` field becomes global-only.** The interesting guards -
  `SessionGuard`, `ThrottleGuard`, `AuditContextMiddleware` - stop being an app-level
  array and become each feature module's declaration. The options provider keeps only
  what is genuinely app-wide.
- **W0, the deprecation phase, is deleted.** Nobody is consuming dunx, so shipping the
  new API alongside the old one is work with no beneficiary. The migration _guide_ is
  still worth writing, for the template's own diff.

Everything else in that plan is unaffected and still wanted.

## Open questions

1. ~~Ancestor middleware inheritance: in or out?~~ **Decided: out.** Middleware applies
   to the declaring module's own controllers and nothing else. "Importing a module
   silently changes my request path" is the surprise this whole change exists to remove,
   and an external review of the design independently landed on the same answer. Revisit
   only with a concrete case.
2. ~~Is local-shadows-imported a warning, an error, or silent?~~ **Decided: a warning**,
   logged once at boot naming the token, the declaring module and the shadowed one. Nest
   is silent and it costs people hours. Not an error, because deliberate rebinding is
   the feature.
3. **Do controllers get their own scope?** They are providers today. If a controller
   could declare private providers the model gets another level for little gain -
   recommend no, controllers stay in their module's scope.
4. **Does `exports` accept a module reference from day one?** It is what makes facade
   modules work, and leaving it out invites a token-listing sprawl that is painful to
   undo. Recommend yes.
5. **What happens to `registerDefault`?** It becomes "bind into the global scope if
   nothing else claims the token", which is nearly the same code. Confirm that
   `Logger`-in-global still loses to an app module that binds `Logger` locally, since
   local-wins now does that job.

## Still open

The container, the packages, the examples and the scaffolder are done and green. What
has not been done:

- **`dunx-template` has not been migrated.** It consumes `@dunx/*` from npm, so it needs
  this released first. Its modules need `imports`/`exports`, and its `ThrottleGuard` and
  `AuditContextMiddleware` are the two guards that should stop being app-level and
  become their features' own `middleware` - which is the acceptance test for whether
  module scoping paid off in a real app.
- **`@dunx/mcp`'s readers do not report scope or visibility.** `providersOf` and
  `modulesOf` still describe a flat graph, so an agent asking "what provides X" cannot
  say which module owns it or whether it is exported. Straightforward now that
  `ScopeGraph` is exported from core.
- **The guide has no page on it.** `docs/guide/04-modules.md` describes the flat
  container.
- ~~The boot-time cost has not been measured.~~ **Measured, and it is a non-issue.**
  Building the container for `examples/full` - 16 modules, every feature - is a
  **median 1.7 ms** (min 1.5, max 19.3 on a cold first run), which covers the scope
  graph, the export fixed point, the per-scope flattening and eager resolution of every
  provider. A regression was accepted in advance; at this magnitude even doubling it
  would be under a millisecond, so the flattening decision needs no defending. The
  ~53 ms in `tools/bench` is `HttpFactory` boot including the oxc parse, route discovery
  and document generation, and none of that moved.
