# Too many ways to declare a module, and to name a dependency

**Feedback, from consuming dunx in `dunx-template`.** The complaint, in the owner's
words: "I really dont like this mixture of functional and class programming - what is
this all over the place?", pointing at `httpClient()` returning a token, `inject()`,
`HttpOptions` being threaded through two call sites, and `src/app.module.ts` being
"hacky".

Three of the four are real. This file separates the principle that is fine from the
places dunx actually violates it, because the fix is different in each case.

## The principle is coherent: a class is a token, a function is not

dunx has no parameter decorators - TC39 standard decorators have none and never will -
so `@dunx/transform` reads constructor **parameter types**, and the only thing that
survives type erasure as a runtime value is a **class**. That is not a style
preference, it is the whole reason the DI works without `reflect-metadata`.

So:

- **Classes are the entire injection vocabulary.** Services, `Logger`,
  `RequestContext`, `SyncDatabase`, `QueueOptions`, `Storage`, `HttpService`. An
  interface would be erased, so a contract is an `abstract class`.
- **Functions are the things that are never injected.** `provide`, `token`, `metaKey`,
  `meta`, `paginate`, `pageOf`, `parsePageOptions`, `encodeCursor`. None of these is a
  dependency; making any of them a class would be ceremony for nothing.

That split should be stated in CLAUDE.md as a rule, because it is currently only
implicit and it is what makes the surface predictable. Where it genuinely breaks down
is below.

## Violation 1 - three ways to declare a module

```ts
@Module({ providers: [X] })            // 1. decorated class
class UsersModule {}

class DbModule {                       // 2. undecorated class + static factory
  static forRoot(o): DynamicModule { return { module: DbModule, providers: [...] }; }
}

export const appModule = (o) => ({     // 3. a bare factory function
  module: AppModule, imports: [...],
});
```

Form 3 exists in `dunx-template` **only to dodge a core footgun**, and that is the
part to fix rather than the template.

`resolveRef` in `packages/core/src/di/module.ts` merges a `DynamicModule` with any
`@Module` metadata on the class it names by **concatenation**:

```ts
options: {
  imports: concat(declared?.imports, ref.imports),
  controllers: concat(declared?.controllers, ref.controllers),
  providers: concat(declared?.providers, ref.providers),
},
```

So the natural shape - a decorated `AppModule` with a `static forRoot(options)` that
configures it differently for tests - registers **both** lists. `ConfigModule` appears
twice and boot dies with a duplicate-binding error that names the same module twice:

```
AppError: Duplicate binding for ConfigInput: bound by module "ConfigModule"
and module "ConfigModule". The container is flat - one binding per token.
```

The template's workaround is an undecorated `AppModule` plus an `appModule()`
function, with fifteen lines of comment explaining why. That is the "hacky" file, and
it is hacky for a good reason.

**No dunx package benefits from the concatenation.** Every configurable module in the
repo - `DbModule`, `RedisModule`, `QueueModule`, `OpenApiModule`, `LoggerModule`,
`QueueDashboardModule` - is an **undecorated** class with static factories, so none of
them has declared metadata to merge. The behaviour has no beneficiary and one known
victim.

**Proposed:** make declaring both a **boot error** naming the class and both option
sets, with the message saying to pick one. Non-breaking for everything in the repo and
for any consumer not already hitting the duplicate-binding failure, and it turns a
confusing symptom into a direct instruction. Overriding instead - the `DynamicModule`
wins - is the other candidate and is what NestJS does; it is friendlier but silently
discards a decorator someone wrote, which is the failure mode dunx generally refuses.

Once that lands, form 3 disappears: the template becomes a decorated `AppModule` with
`static forRoot(options)`, like every other module.

## Violation 2 - three ways to name a dependency

```ts
constructor(private readonly repo: UsersRepository) {}     // 1. the parameter type
readonly cache = inject(SOME_TOKEN);                       // 2. inject() in a field
readonly http = inject(httpClient('email'));               // 3. a token-returning fn
```

Form 1 is the point of the framework. Form 2 is a legitimate escape hatch for a value
with no constructor parameter to hang off, and is documented as such.

**Form 3 is the inconsistency**, and it is avoidable. `httpClient(name)` returns a
`Token<HttpService>`, and a token is not a class, so it can never be a constructor
parameter - which forces form 2 on every consumer of a named client.

dunx already has a better answer for exactly this problem, and uses it for config:

```ts
export class AppConfigService extends ConfigService<AppConfig> {}
ConfigModule.forRoot({ validate, as: AppConfigService });
constructor(private readonly config: AppConfigService) {}   // a plain parameter
```

**Proposed:** `HttpModule` takes `as` rather than a name.

```ts
export class EmailClient extends HttpService {}
HttpModule.forRootAsync({ useFactory, inject }, { as: EmailClient });
constructor(private readonly email: EmailClient) {}
```

A subclass is a real class, so it is a token _and_ a constructor parameter type, and
form 3 stops existing. `httpClient(name)` can stay as a deprecated alias or be dropped
pre-1.0. The same treatment applies to any future module that wants several named
instances - and `as` being the established spelling is worth more than either option
being individually prettier.

This was already felt in the template: `EmailService` used `inject(httpClient('email'))`
for a single outbound client, which bought nothing over `HttpService` and cost the
plain constructor. It now injects `HttpService` directly.

## Violation 3 - `HttpOptions` cannot read config, so it is threaded by hand

Already open as
[http-options-before-container](./http-options-before-container.md); recorded here
because it is the same complaint from the consumer's side. `HttpOptions` is an argument
to `HttpFactory.create`, which is the call that _builds_ the container, so
`middleware`, `onError`, `notFound`, `requestLogging` and `relay` cannot inject
anything. Middleware is registered by class and never by instance, so
`app.useGlobalInterceptors(new X(config))` has no counterpart.

What that costs a real app, visible in `dunx-template`:

- `validateConfig(Bun.env)` is called a second time in `main.ts`, before `create()`.
  It is pure, so it cannot disagree with itself, but config is validated twice and the
  second call is invisible to the container.
- The options have to live in their own module (`src/http.options.ts`) as a function of
  the config, because the same object must reach `HttpFactory.create` **and**
  `createTestServer` - neither reads it off the container, and a suite that forgets it
  gets a server with no guards and no error mapper that still boots and still answers.

That second point is the "http options all over the place" feeling, and it is a
symptom of the first.

## Not a violation

`provide()`, `token()`, `metaKey()`/`meta()` and `@dunx/infra/pagination`'s functions
are all correct as functions - none is ever injected. `appModule()`/`workerModule()`
returning two different graphs from one shared `foundation()` is also right: the web
process and the worker genuinely share a module list and nothing else, and expressing
that as data is clearer than two decorated classes with a common base.
