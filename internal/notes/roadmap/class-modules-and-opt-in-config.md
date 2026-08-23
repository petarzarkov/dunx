# Class modules with opt-in configuration, and nothing else

**The next priority, and partly shipped.** Requested directly, and it supersedes
the earlier `api-surface-consistency` item, whose three findings are folded in
below.

W3 and W4 are done, and every `*Options` in the framework is a class:
`QueueOptions`, `RedisOptions`, `DashboardOptions`, `StaticOptions`,
`SqliteOptions`, `AuthOptions`. **W1, W1b, W2 and W6 are open** - `HttpOptions` is
still a plain object `HttpFactory.create` evaluates before the container exists,
`AppError` still carries no `status`, and `redisConnection(name)` is still a token
function rather than a subclass.

The rule to reach:

> A consumer configures dunx by **declaring a class** and, where it needs to differ
> from the default, **opting in to named options**. It never writes a function dunx
> calls back, never assembles an options object dunx destructures, and never restates
> a third-party library's own configuration shape.

Everything below is evidence that dunx currently fails this, followed by the work to
fix it. The evidence is the `dunx-template` port, because that is the only place dunx
has been consumed end to end.

## The four exhibits

Each of these is a file a consumer had to write, and in every case what leaked was
**framework knowledge**, not application logic.

| File                              | Lines | What the consumer had to know that is not their business                                                                                     |
| --------------------------------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/auth/auth.options.ts`        |    75 | better-auth's whole option tree, which plugins dunx needs, `bunPassword`, `generateId`, and that `satisfies` rather than `:` is load-bearing |
| `src/auth/auth.document.ts`       |    50 | that a _second_ `betterAuth()` instance must exist purely to be asked for a schema                                                           |
| `src/core/errors/error-mapper.ts` |   130 | SQLite constraint codes, and that `@dunx/infra/pagination`'s errors need placing by hand                                                     |
| `src/http.options.ts`             |    80 | that these options cannot be injected, so they must be a function called twice                                                               |
| `src/core/force-exit.ts`          |    60 | a measured bullmq/Bun defect, and how to write a signal handler around it                                                                    |

**395 lines.** Almost none of it is about the application. Two specifics are worth
naming because they are the shape of the whole problem:

- `auth.options.ts` ends with a comment explaining that a `: BetterAuthOptions`
  return annotation widens the `plugins` tuple, which makes `betterAuth()` infer an
  instance with no `generateOpenAPISchema`, which then fails a _weak-type_ check in
  `betterAuthDocument`. That is four layers of type inference the consumer is
  debugging on dunx's behalf.
- `http.options.ts` opens by explaining that the object must be passed to
  `HttpFactory.create` **and** `createTestServer`, because neither reads it from the
  container, and that "a suite that forgets them gets a server with no guards and no
  error mapper, which still boots and still answers, so the omission is silent." A
  documented silent-failure mode is a design defect, not a caveat.

## The rule that decides what becomes a class

Without this, "everything in classes" turns into ceremony. The test is **who owns the
knowledge**, and there are three answers.

**1. Framework wiring: must be a class, resolved from the container.** Anything dunx
calls, holds, or needs configured. Guards, middleware, error filters, options,
lifecycle. These become classes because a class is dunx's only injectable unit -
`@dunx/transform` reads constructor parameter _types_, and a class is the only thing
that survives type erasure as a runtime value. That is why this is not a style
preference: a function literally cannot have dependencies here, which is why every
one of the exhibits above takes `config` as an argument and gets threaded by hand.

**2. Application domain: stays whatever reads best.** `sanitize(row)`,
`present(row)`, `userTopic(userId)`, a zod schema, a drizzle column helper. dunx
never calls these and has no opinion. `paginatedOf(item, id)` returning a zod schema
is correct as a function and must not become a class.

**3. A library's own idiom: stays the library's.** drizzle's `sqliteTable`, zod's
builders, better-auth's plugin functions. dunx wraps _whether and how_ they are
configured, never re-spells them.

Decorators are a fourth case and are settled: they are functions because TC39 says
so.

## Registration versus discovery, and where each is right

"Improve IoC" has a sharper answer than "make it a class", because dunx **already**
inverts control for most of its extension points and is inconsistent about which
ones.

Discovered from the module graph, with no registration call: `@Controller` routes,
`@Gateway` handlers, `@JobHandler` methods, seeders. You declare, dunx finds them.

Listed in an options array: global middleware, `onError`, `contribute`. You declare
_and_ register, in two places.

The tempting conclusion is to discover everything - a `@GlobalMiddleware()` decorator
and dunx assembles the chain. **Resist it for middleware specifically**, and the
reason came out of this repo's own debugging rather than theory:

- The queue dashboard had to be registered **ahead of** `SessionGuard`, or every
  dashboard request was answered `401` before its own `authorize` ran.
- `SessionGuard` has to precede `ThrottleGuard`, so the throttler can count per user
  rather than per address.
- `AuditContextMiddleware` has to follow both, so the audit stamp can name a caller.

Every one of those is visible at a glance in `middleware: [A, B, C]` and would become
invisible in three decorators carrying `order: 10`, `order: 20`, `order: 30` in three
different files. An ordered list _is_ the documentation. So:

- **Order is load-bearing: keep the explicit list**, and move it into the options
  provider (W1) so it can at least inject.
- **Order is irrelevant: discover it.** Error filters are keyed by the error they
  handle, and document contributors are merged - neither has a meaningful sequence, so
  both should be found in the graph rather than listed. That is W2 and W8.

This is the useful refinement to "centralize the wiring": centralising _registration_
is right, centralising _order_ into an implicit number is not.

## The keystone: options are a provider, not an argument

Everything else is easier once this lands, and two other items are blocked on it.

### Current

```ts
const boot = validateConfig(Bun.env); // validated a second time
const app = await HttpFactory.create(root, httpOptions(boot));
```

`HttpOptions` is an argument to the call that _builds_ the container, so nothing in
it can inject: `middleware`, `onError`, `notFound`, `requestLogging`, `relay` and
`relayChannel` all have to be computed before any provider exists. Hence a pure
function of the config, hence config validated twice, hence the same object threaded
into the test harness by hand.

### Proposed

```ts
export class AppHttpOptions extends HttpOptionsProvider {
  constructor(private readonly config: AppConfigService) {
    super();
  }

  override middleware = [SessionGuard, ThrottleGuard, AuditContextMiddleware];
  override notFound = 'public' as const;

  override get requestLogging(): RequestLoggingInit {
    const log = this.config.get('log');
    return { requestBody: log.requestBody, responseBody: log.responseBody };
  }
}

@Module({ providers: [AppHttpOptions] })
export class HttpConfigModule {}

const app = await HttpFactory.create(AppModule.forRoot());
```

`HttpOptionsProvider` is an **abstract class with a default for every field**, so a
consumer overrides only what differs - that is the "opt-in configuration" half of the
rule. It joins `Logger` and `RequestContext` as an always-bound contract: core binds
a default after every module's, so a module that binds one wins. That precedent is
already established and documented; this is the third instance of it rather than a new
mechanism.

### The ordering problem, and why it is solvable

`HttpFactory.create` reads `options` at two different times today:

| Field                   | Read when            | Can it move to a provider?                 |
| ----------------------- | -------------------- | ------------------------------------------ |
| `overrides`             | before the container | **No.** It substitutes bindings _into_ it. |
| `requestLogging: false` | before the container | Yes, with one change - see below.          |
| everything else         | after the container  | Yes, directly.                             |

Only `requestLogging` is awkward: its `false` case currently decides whether
`RequestLoggingMiddleware` is bound at all. The fix is to **always bind it** and let
the resolved options decide whether it is in the chain. Binding one provider that is
never used costs a constructor call at boot; the ordering knot it unties is worth
more than that.

So `HttpFactory.create(root, { overrides })` is the whole remaining signature, and
`overrides` staying an argument is correct rather than a compromise - it is the test
harness reaching in before the container exists, which is exactly what it is for.

### What it deletes

`src/http.options.ts` and its docstring, the second `validateConfig(Bun.env)` call in
`main.ts`, and the silent-failure mode in every suite: `createTestServer({ modules })`
builds the same graph, so it resolves the same `AppHttpOptions`. **A suite can no
longer accidentally run without the app's guards.**

It also unblocks the `basePath` derivation in the auth work below, because a
container-resolved options object is a place the global prefix can finally live.

## Shipped: `onError` accepts a class

The first of these landed in `@dunx/http`. `HttpOptions.onError` now takes an
`ErrorFilter` **class** as well as an `ErrorMapper` function, and the class is
resolved from the container - so a filter injects whatever it needs:

```ts
export class AppErrorFilter extends ErrorFilter {
  constructor(
    private readonly logger: Logger,
    private readonly config: AppConfigService,
  ) {}

  catch(error: unknown, req: Request): Response { ... }
}

HttpFactory.create(root, { onError: AppErrorFilter });
```

`ErrorFilter` is an `abstract class` with one `catch(error, req)` method, named for
NestJS's `ExceptionFilter.catch` because that is the vocabulary it replaces. Details
worth remembering:

- **A function still works.** `isErrorFilter` discriminates on the prototype carrying
  a `catch`, which a class declaration always has and neither an arrow function nor a
  `function` expression ever does. Checking `prototype` alone would be wrong, since
  `function mapper() {}` has an empty one.
- **The filter is resolved at construction, its `catch` looked up per call**, so a
  test can rebind the filter and a request still costs one method call.
- **A dependency-free filter needs no `providers` entry**, because resolving a class
  the container can construct self-binds it. One with dependencies needs those
  bindable, exactly as a `middleware` entry does.
- The existing default stays a curried `errorMapper(logger)`. It is internal, and
  turning it into a provider class is a separate change with no consumer asking for
  it.

`packages/http/src/server/error-filter.test.ts` covers the discrimination, the
resolution, both statuses through a filter, self-binding, and that a plain mapper is
unaffected.

**The template cannot adopt it until this is published** - it consumes `@dunx/http`
from npm - and when it does, W2 above is what makes the adoption small rather than a
130-line class.

## Two naming constraints that will bite a first draft

Both come from reviewing an external plan for this work, which proposed
`DunxAuthOptions`, `DunxHttpOptions` and `DunxExceptionFilter`, and an inbound
`HttpModule.forRoot()`.

- **No identifier may start with `Dunx`.** `dunx/no-brand-prefix` in
  `scripts/oxlint-plugin.js` reports every `Identifier` whose name does, so those three
  names fail `lint:check` on the first run. The brand belongs in the package name. The
  correct names already exist or are obvious: `AuthOptions`, `HttpOptions`,
  `ErrorFilter`.
- **`HttpModule` is taken, deliberately.** `@dunx/http/client` exports it for the
  _outbound_ client, and the subpath split exists precisely so `HttpFactory` (serving)
  and `HttpModule` (calling out) cannot be confused at an import site. An inbound
  `HttpModule.forRoot()` would collide with it.

The second is more than a name clash, and it is worth understanding before designing
this: **dunx has no inbound HTTP module to import.** `HttpFactory.create(root)` _is_
the container build. A plan that reads "import `HttpModule`, pass it the app-level
prefix and logging preferences" is describing NestJS's shape, where the module tree is
assembled first and an HTTP adapter is attached afterwards. In dunx the two are one
call, which is exactly why the options cannot inject today - and why W1 has to come
first for any of it to be possible.

## Work items

Ordered by dependency. Each says what it deletes from the template, because that is
the measure.

### W0 - the migration guide, but no deprecation window

Originally scoped as "ship the new API alongside the old, mark the old `@deprecated`,
remove it a minor later". **That is deleted: nobody is consuming dunx yet**, so a
deprecation window is work with no beneficiary. Change the API and move on.

What survives is the **guide**, under `docs/guide/`, one section per item showing the
deleted file and the line that replaces it. `docs/MIGRATION-FROM-NEST.md` is the model:
a table of before and after, not prose. It is still worth writing because
`dunx-template` has to be migrated regardless, and a step that cannot be written as a
diff against the template is not specified well enough to ship.

**Prerequisite: already met.** Module-scoped DI shipped in 1.0.0, and it changed what
W1 means - see "What module scoping already settled" at the end.

### W1 - `HttpOptionsProvider` (keystone)

Above. Everything else is independent of each other but easier after this.

**The shape of the problem, absorbed from what used to be its own roadmap file.**
`HttpOptions` is an argument to `HttpFactory.create`, which is the call that _builds_
the container, so `requestLogging`, `onError` and `middleware` cannot read validated
config. Middleware is registered by class, never by instance, so NestJS's
`app.useGlobalInterceptors(new X(config))` after `app.get(ConfigService)` has no
counterpart. `dunx-template` works around it by calling `validateConfig(Bun.env)` a
second time in `main.ts` before `create()` - pure, so it cannot disagree with itself,
but config is validated twice and the second call is invisible to the container.

The fix needs a decision either way: a post-create hook that can still install
middleware, or accepting that anything needing config is resolved from the container
by a middleware taking it as a constructor dependency.

The `OpenApiModule` half of that file is **done**. `forRootAsync({ root, useFactory,
inject })` produces `title`, `version`, `description`, `servers`, `path` and
`jsonPath` from a factory that may inject, and the mount paths work because `@Get`
takes a `RoutePath` thunk resolved at route discovery, which runs after every
provider has settled.

**Hard part:** `relay: new RedisRelay({...})` is an _instance_ the app constructs.
Under a provider it becomes a bound provider, which is better - but `RedisRelay`
currently takes connection options the app assembles from config, so it wants the same
treatment: `WsRelayModule.forRootAsync({ useFactory, inject })`. Do that in the same
pass or the options provider still has one hand-built object in it.

### W1b - the imperative surface, which is where IoC actually breaks

**The largest single anti-IoC surface in dunx, and neither this plan's first draft nor
the external review named it.** Everything between `create()` and `listen()` in
`main.ts`:

```ts
app.setGlobalPrefix(appConfig.prefix);
app.set('trust proxy', cors.trustProxy);
app.enableCors({ origin: cors.origin, credentials: config.get('isProd') });
app.enableShutdownHooks();
const cancelWatchdog = forceExitAfter();
```

Five method calls on a constructed application, each of which is **configuration**, in
an order that matters, every one of which throws if called after `listen()`. That is
the opposite of declaring what you want and letting the container wire it. It is also
why `main.ts` is a hundred lines that every consumer copies and then edits by hand.

Under W1 all five are fields on the options provider:

```ts
export class AppHttpOptions extends HttpOptionsProvider {
  constructor(private readonly config: AppConfigService) { super(); }

  override get prefix() { return this.config.get('app').prefix; }
  override get cors() { return { origin: ..., credentials: ... }; }
  override trustProxy = true;
  override shutdown = { signals: ['SIGTERM', 'SIGINT'], forceExitAfterMs: 8000 };
}
```

and `main.ts` collapses to:

```ts
const app = await HttpFactory.create(AppModule.forRoot());
await app.listen();
await app.closed;
```

Three lines, and the port comes from the options provider too. Two consequences worth
being explicit about:

- **The "must be called before `listen()`" class of error stops existing.** It is
  currently a runtime throw with a helpful message, which is the best a method-call API
  can do. A field on a provider resolved before the route table is built cannot be set
  too late.
- **`app.use()` stays**, and should. It is the one imperative call with a real use: a
  test or a script appending middleware to an already-built app. Keeping it while the
  configuration path is declarative is the right split, and it is what `overrides`
  already does for bindings.

The URLs `main.ts` logs at the end are the remaining honest reason to write code
there, and even those are a candidate for a `logStartup` option.

### W2 - an error is mapped by whoever raised it

`error-mapper.ts` is 130 lines and only about 20 are the app's own errors. The rest is
knowledge that belongs to the package that produced the error:

| Error                             | Raised by                | Belongs to       |
| --------------------------------- | ------------------------ | ---------------- |
| `ValidationError`, `HttpError`    | `@dunx/http`             | already handled  |
| `SQLiteError` constraint codes    | `bun:sqlite` via drizzle | `@dunx/infra/db` |
| `CursorError`, `PageOptionsError` | `@dunx/infra/pagination` | that subpath     |
| `ConfigError`                     | `@dunx/core`             | core             |

The obstacle is real: **`@dunx/infra` must not depend on the web layer**, so it cannot
raise an `HttpError` or ship a filter that imports one. The way through is not a
dependency, it is a number.

**Give `AppError` an optional `status`.** An integer is not the web layer. Then:

- `CursorError` declares `status = 400` in `@dunx/core`'s terms, importing nothing.
- `@dunx/infra/db` catches `SQLiteError`, reads the constraint code it already
  understands, and rethrows its existing `DatabaseError` with `status = 409` or `400`.
  The constraint-code table moves to where the driver is, which is where it belongs.
- `@dunx/http`'s default filter maps **any** `AppError` carrying a `status`, and
  anything else to 500.

An app then writes a filter only for its _own_ errors, and the envelope shape becomes
one option rather than 130 lines. `onError` already accepts a class as of the last
change, so the mechanism exists; this is about who fills it.

**Deletes:** roughly 110 of the 130 lines, and the `import { SQLiteError } from
'bun:sqlite'` from application code entirely.

### W3 - `AuthModule` configures better-auth, the app opts in

**Shipped.** `AuthOptions` is a class, and `AuthModule.forRoot` / `forRootAsync`
take it. The `plugins` and `betterAuth` escape hatches below are on it.

**Current:** 75 lines restating better-auth's options, plus 50 more building a second
instance for its schema.

**Proposed:**

```ts
AuthModule.forRootAsync(
  {
    useFactory: (config: AppConfigService, db: DbConnection) => ({
      secret: config.get('auth').secret,
      baseUrl: config.get('auth').baseUrl,
      database: drizzleDatabase(db, { schema }),
      // Opt-in capabilities, not a plugin array:
      roles: true, // better-auth's admin(): role, ban, impersonation
      bearerTokens: true, // Authorization: Bearer instead of a cookie
      openapi: true, // the schema contribution, and no second explorer
      emailAndPassword: { minLength: 8, maxLength: 64 },
      social: config.get('auth').providers,
    }),
    inject: [AppConfigService, DbConnection] as const,
  },
  '/auth',
);
```

dunx supplies, and the app stops knowing about: the plugin list, `bunPassword` (it is
already the default when `emailAndPassword` is on), `generateId` producing a uuid to
match the columns better-auth writes to, the cookie cache, and `basePath`.

Three things this is really fixing:

- **`basePath` versus the mount.** Two different strings for one URL, and getting it
  wrong silently documents the whole auth surface at a path nothing answers on - which
  happened, twice, in opposite directions. dunx knows the mount and (after W1) the
  global prefix, so it should derive `basePath` and stop asking.
- **The `satisfies` trap.** dunx builds the instance, so dunx can keep the plugin
  tuple's inference internally. The consumer never sees it.
- **The second instance.** With `openapi: true`, `AuthModule` binds an
  `AuthDocumentContributor` provider that `OpenApiModule`'s factory injects. No
  database-less duplicate, no risk of the document describing a different API than the
  one running.

**Deletes:** `auth.options.ts` and `auth.document.ts` in full, about 125 lines,
including the `AUTH_MOUNT` / `authBasePath` pair.

**Escape hatch, mandatory:** a `plugins` field for anything dunx does not name, and a
`betterAuth` field taking raw options merged last. Rule 1's second half says the
library owns the abstraction - an app must still be able to reach it. Opt-in
configuration is a shortcut over the library, never a wall in front of it.

### W4 - the shutdown timeout, which is smaller than it looks

**Shipped.** `ShutdownHooks` in `@dunx/core` takes
`enableShutdownHooks(signals, { exitAfterMs })`, defaulting to 1000 ms. The timer
**is** `unref()`d, against the guess recorded below: an unref'd timer cannot hold
the runtime open, so a process with nothing pending exits immediately and the
callback never fires, and it fires only when a handle outside the container is
still holding the loop. It logs before exiting, and `exitAfterMs: false` is the
escape hatch for an app that does not own its process. The analysis below is kept
for the reasoning it records.

`force-exit.ts` is 60 lines in application code, and **most of it is already in the
framework**: `App.enableShutdownHooks(signals)` registers the `SIGTERM`/`SIGINT`
handlers, guards against double-registration with an internal flag, and runs the hooks.
The only thing the template adds is a **timeout** for a shutdown that never resolves.

So this is one option on an existing method, not a new subsystem:

```ts
app.enableShutdownHooks({ forceExitAfterMs: 8000 }); // or a field under W1b
```

The timer's non-obvious properties are framework knowledge and move with it: it must
not be `unref`'d (an unref'd one was tried, on the reasoning that it only needs to fire
when something else holds the loop open, and it never fired), it is cancelled once
`closed` resolves so the healthy path exits immediately, and its message goes to
`console.warn` because the logger's transport may already be torn down.

**It must stay opt-in, not automatic.** The external review proposed providing it
"automatically inside a foundational CoreModule". That would break the test harness:
`createTestApp` and `createTestServer` build many applications per process, and a
watchdog that installed signal handlers on every one would leak listeners until Node
warns. The existing `#hooked` guard is per-application, not per-process. Explicit is
correct here.

Cross-reference [queue-shutdown-sigterm](./queue-shutdown-sigterm.md): the reason a
timeout is needed at all is defects A and B. When they are fixed upstream the default
becomes zero, and one framework default changes rather than every app's copy.

**Deletes:** `force-exit.ts`, and the `cancelWatchdog()` / `process.exit(0)` pair at
the bottom of `main.ts` and `worker.ts`.

### W5 - one way to declare a module

`resolveRef` in `packages/core/src/di/module.ts` **concatenates** a `DynamicModule`'s
options with any `@Module` metadata on the class it names:

```ts
imports: concat(declared?.imports, ref.imports),
providers: concat(declared?.providers, ref.providers),
```

So the natural shape - a decorated class with a `static forRoot()` that configures it
differently for tests - registers both lists and dies with a duplicate-binding error
naming the same module on both sides. **No package in this repo benefits**: every
configurable module (`DbModule`, `RedisModule`, `QueueModule`, `OpenApiModule`,
`LoggerModule`) is an undecorated class with static factories, so none has metadata to
merge. One footgun, no beneficiary.

**Proposed:** declaring both is a **boot error** naming the class and both option sets,
telling the author to pick one. Non-breaking for anything not already failing.
Overriding instead is what NestJS does and is friendlier, but silently discards a
decorator someone wrote, which is the failure mode dunx refuses elsewhere.

The template already reads better for having been fixed to an undecorated
`AppModule.forRoot()`, which needed no framework change - but the trap is still there
for the next person.

### W6 - a named provider is a subclass, not a token function

```ts
readonly http = inject(httpClient('email'));   // today
```

`httpClient(name)` returns a `Token<HttpService>`, and a token is not a class, so it
can never be a constructor parameter - which forces `inject()` in a field on every
consumer of a named client. dunx already has the right answer and uses it for config:

```ts
export class EmailClient extends HttpService {}
HttpModule.forRootAsync({ useFactory, inject }, { as: EmailClient });
constructor(private readonly email: EmailClient) {}
```

A subclass is a real class, so it is a token _and_ a parameter type. `as` is already
the established spelling (`ConfigModule.forRoot({ validate, as })`), which is worth
more than either option being individually prettier. Apply the same treatment to any
future module wanting several named instances.

### W7 - config validation

```ts
ConfigModule.forRoot({ validate, as: AppConfigService });
```

`validate` is a function the app writes, and unlike the others it is **defensible**:
it is the one place the app genuinely owns the knowledge, and a schema DSL was
rejected on purpose. Two smaller changes are still worth it:

- Accept a **Standard Schema** directly as an alternative to a function, so
  `ConfigModule.forRoot({ schema: envSchema, as })` needs no wrapper. Route validation
  already targets Standard Schema, so this costs nothing and picks no vendor.
- The `as` subclass should be the documented default rather than an option, because
  without it `inject: [ConfigService]` resolves to
  `ConfigService<Record<string, unknown>>` and a factory annotating the app's type is
  rejected. Consumers hit this and the error is opaque.

### W8 - contributions are providers

`contribute: [authDocument(boot)]` is a function producing a fragment. It should be a
provider class, which is what lets W3 delete the second better-auth instance. The
`DocumentContributor` type already accepts a thunk, so this is a widening rather than
a break.

### W9 - the CLI entry

`openapi.config.ts` exports `openapi = () => ({ root, title, contribute })` for
`bunx dunx-openapi`. It is a function because a CLI has no container. Lowest priority,
and it may be correct as it is - but if `AppModule.forRoot()` plus a
`DocumentContributor` provider can be read statically the way `@dunx/mcp` reads
routes, the file disappears too.

## Before and after, in one table

| Domain         | Today, in application code                                             | Target                                                          |
| -------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| HTTP options   | `httpOptions(config)`, a function threaded into two call sites         | `class AppHttpOptions extends HttpOptionsProvider`              |
| Bootstrap      | five imperative `app.*` calls between `create()` and `listen()`        | fields on that provider; `main.ts` is three lines               |
| Error mapping  | 130 lines including SQLite codes and pagination errors                 | one filter for the app's own errors; the rest map themselves    |
| Authentication | 125 lines of better-auth options plus a second instance for its schema | `AuthModule.forRootAsync({ roles: true, openapi: true, ... })`  |
| Shutdown       | `forceExitAfter()` and a signal handler in app code                    | `enableShutdownHooks({ forceExitAfterMs })`                     |
| Named client   | `inject(httpClient('email'))` in a field                               | `class EmailClient extends HttpService` as a parameter          |
| Module shape   | a bare factory function, to dodge a concat footgun                     | `@Module` or `static forRoot()`, and declaring both is an error |

## Sequencing

1. **W5** first. Small, a pure bug fix, and it lets every later example use the
   natural module shape.
2. **W1** then **W1b**, in that order and probably in one release. The keystone and the
   thing it exists for - shipping W1 without W1b leaves `main.ts` imperative and the
   win invisible.
3. **W2** and **W4** in parallel. Independent of everything else, and W4 is an
   afternoon now that the signal handling turns out to already exist.
4. **W3**, the largest single win in consumer lines, and the one needing the most care
   over the escape hatch. It wants W1b's prefix field for the `basePath` derivation.
5. **W6**, **W7**, **W8** as cleanups.
6. **W9** only if it falls out of W8.

**W0's guide section runs alongside each item**, not as a phase of its own. A
documentation phase scheduled last gets skipped, and one scheduled first goes stale.

## What this is not

- **Not a ban on functions.** Category 2 and 3 above stay exactly as they are. A plan
  that turned `sanitize(row)` into a class would be worse than the problem.
- **Not a wall in front of a library.** Every opt-in configuration needs a documented
  way through to the underlying options. `AuthModule`'s `plugins` and `betterAuth`
  fields are not optional extras; they are what keeps Rule 1's second half true.
- **Not a reason to defer other work.** This is the higher priority because it
  changes what every consumer writes on day one.

## The measure

`dunx-template` is the fixture, and the numbers are checkable rather than rhetorical.

| Measure                                      | Today | Target   |
| -------------------------------------------- | ----: | -------- |
| The five exhibit files                       |   395 | under 60 |
| `main.ts`, between `create()` and `listen()` |   ~35 | 0        |
| `main.ts` in total                           |   116 | under 20 |
| Framework-wiring `export const` in `src/`    |     6 | 0        |

Every line that remains should be a decision only this app could make: which guards, in
what order, which better-auth capabilities, and what its own errors mean.

The third row is the one to watch, because it is the one a reader feels. A bootstrap
file with nothing between `create()` and `listen()` is visible proof that configuration
became declarative; a shorter `auth.options.ts` is only a smaller file.

The last row targets 1 rather than 0 on purpose: `validateConfig` survives, because W7
concludes it is the one place the app genuinely owns the knowledge.

## Open questions

1. **Does `HttpOptionsProvider` use fields, getters, or methods?** Fields are the
   cleanest to override and the easiest to get wrong when a value depends on config
   resolved later. Getters read well and are re-evaluated per access, which may be
   surprising. Probably fields for constants and getters for anything computed, but
   the abstract class has to pick one shape and document it.
2. **Does `AppError.status` belong in core at all?** It is an HTTP concept in a
   package that knows nothing about HTTP. The counter-argument is that it is an
   integer with no semantics attached, and the alternative is a dependency inversion.
   Worth a second opinion before W2 lands.
3. **How much of better-auth does `AuthModule` name?** Every capability named is a
   capability dunx now owns the defaults for, and a compatibility surface across
   better-auth versions. Start with what the template actually uses -
   `roles`, `bearerTokens`, `openapi`, `emailAndPassword`, `social` - and let the
   `betterAuth` escape hatch carry everything else.
4. **Should `notFound: 'public'` become the default?** The template overrides it, with
   a written justification, on its first day of use. A default every real consumer
   overrides is the wrong default.

## What module scoping already settled

Module-scoped DI shipped in 1.0.0 and moved the ground under two items:

- **W1's `middleware` field is global-only.** A guard that matters to one feature is
  declared by that feature's module and resolved from its scope, so the options
  provider keeps only genuinely app-wide middleware.

  **The array shrinks less than this predicted, and that is now measured rather than
  guessed.** All three of `dunx-template`'s app-level entries stayed app-level:
  `SessionGuard` as expected, and `ThrottleGuard` and `AuditContextMiddleware` for
  reasons recorded in [architecture/http.md](../../../docs/architecture/http.md), "What module
  middleware is actually for". So W1 should be justified by the imperative-surface
  argument alone, not by an expectation that the list gets short.

- **W1b is unaffected and becomes more valuable.** `setGlobalPrefix`, `cors`,
  `trustProxy` and the shutdown timeout are app-wide by nature; none of them is
  something a module scopes. So the imperative surface is exactly the part module
  scoping does _not_ address, which makes the two plans complementary rather than
  overlapping.

Nothing else in this document depends on the container's shape.
