# @dunx/auth

[Better Auth](https://better-auth.com) for dunx. **This package is not an
authentication system** - better-auth is, and it is very good at it. This is the
wiring: a module that builds the instance from your `ConfigService`, five routes that
mount its handler, a guard that composes with the `@Public()` and `@Roles()` metadata
`@dunx/http` already carries, and two adapters that let it drive Bun's own APIs.

`better-auth` is a **required peer dependency**. Install it yourself and own its
version - dunx does not bundle it - but it is not optional, because this package
imports `betterAuth` as a value and cannot load without it. Marking it optional would
trade an install-time warning for a module-resolution crash.

```bash
bun add @dunx/auth better-auth
```

`drizzle-orm` **is** an optional peer, needed only by `@dunx/auth/drizzle` - which is
its own subpath precisely so that a Prisma, Kysely or MongoDB app never loads it.
`dist/index.js` contains no reference to drizzle, which is the test a peer has to
pass to be called optional.

There is no dunx sign-in flow, no dunx session table, no dunx password reset and no
dunx OAuth. Every one of those is a better-auth feature reached through
`AuthModule.forRoot`'s options, which **are** better-auth's `BetterAuthOptions`. Its
documentation is the documentation.

## What dunx adds

| Export                | What it is                                                            |
| --------------------- | --------------------------------------------------------------------- |
| `AuthModule`          | `forRoot` / `forRootAsync`, binding the instance and mounting it       |
| `Auth`                | The injection token for the better-auth instance                      |
| `SessionGuard`        | Middleware: authenticates, then reads `@Public()` and `@Roles()`       |
| `AuthContext`         | The authenticated caller, reachable from any service in the request    |
| `Principal`           | `{ session, user }` - better-auth's own inferred session type          |
| `bunPassword`         | `Bun.password` bcrypt in place of better-auth's JavaScript scrypt      |
| `redisStorage`        | `secondaryStorage` over `Bun.RedisClient`                             |
| `drizzleDatabase`     | `database` over the drizzle handle `@dunx/infra/db` already opened     |
| `rolesOf`             | The `admin` plugin's `role` column read as a list                     |
| `AuthOptions`         | The resolved options, the `basePath` and where the handler mounted     |

## Getting started

```ts
import { AuthModule } from '@dunx/auth';
import { drizzleDatabase } from '@dunx/auth/drizzle';
import { Module } from '@dunx/core';
import { DbConnection } from '@dunx/infra/db';
import { admin, bearer } from 'better-auth/plugins';

@Module({
  imports: [
    AuthModule.forRootAsync({
      useFactory: (config: AppConfigService, connection: DbConnection) => ({
        secret: config.get('auth').secret,
        baseURL: config.get('appUrl'),
        database: drizzleDatabase(connection),
        emailAndPassword: { enabled: true },
        plugins: [admin(), bearer()],
      }),
      inject: [AppConfigService, DbConnection] as const,
    }),
  ],
})
export class AccountsModule {}
```

That is the whole integration. `forRoot(options)` is the same thing without a factory,
for when the secret is not behind config.

`forRootAsync` exists for the one reason it exists on `LoggerModule`, `DbModule` and
the rest: a zero-argument function cannot read `ConfigService`. It is not a second
mechanism - dunx settles every async factory before the first constructor runs, so
the instance is built and the connection handshaked before anything can ask for
either.

### The database tables

**dunx ships no schema for better-auth's tables.** They are better-auth's, they change
with the plugins you enable, and its own CLI generates them:

```bash
bunx @better-auth/cli generate
```

Put the result in the schema object you already hand `@dunx/infra/db`, and
`drizzleDatabase(connection)` needs no schema argument - `@dunx/infra/db` builds its
handle with `drizzle({ client, schema })`, and better-auth's adapter reads
`db._.fullSchema` off it. `examples/full/src/database/auth.schema.ts` is a
generated schema in place.

A framework carrying its own copy of a library's tables is a copy that rots against
the library that reads them.

## Mounting

`AuthHandler` puts better-auth's `(request: Request) => Promise<Response>` behind five
wildcard routes - `GET`, `POST`, `PUT`, `PATCH` and `DELETE` at `<basePath>/*`.
`Bun.serve` matches a wildcard natively, so **Bun is still the router**: dunx does not
restate, wrap or re-dispatch a single better-auth endpoint, and the `Response` comes
back untouched, `Set-Cookie` headers and redirects included.

`basePath` is better-auth's own option, defaulting to `/api/auth`.

### With `setGlobalPrefix`

better-auth resolves an endpoint by comparing the **whole pathname** to its
`basePath`, so a global prefix makes the mount and the base path two different
strings for one URL:

```ts
// app.setGlobalPrefix('api') turns the `/auth` route into `/api/auth`.
AuthModule.forRootAsync({ useFactory: () => ({ basePath: '/api/auth', ... }) }, '/auth');
```

The second argument is the **route** path; `basePath` is what the browser sees. Get it
wrong and the first request through the handler fails with an `AuthError` naming both
paths, rather than better-auth quietly answering 404 to everything.

## The guard

```ts
// Global - every route needs a session unless it says otherwise.
HttpFactory.create(root, { middleware: [SessionGuard] });

// or scoped - this controller needs one, nothing else does.
@UseGuards(SessionGuard)
@Controller('profile')
class ProfileController {}
```

`AuthModule` registers `SessionGuard` as a provider either way. It resolves the
session through better-auth's own `api.getSession`, so a cookie and the `bearer`
plugin's `Authorization: Bearer <token>` both work, and then reads the metadata
`@dunx/http` already had:

- **`@Public()`** - skipped outright. No session lookup, no rejection, no role check.
  That is what makes the guard safe to install globally: `AuthHandler` is `@Public()`,
  and a sign-in endpoint that required a session could never be reached.
- **`@Roles('admin', 'editor')`** - a 403 unless the caller holds one of them.
  `@dunx/openapi` already reads the same key for its security schemes.

A public route that wants to *adapt* to an optional caller asks better-auth itself:

```ts
const principal = await this.auth.api.getSession({ headers: req.headers });
```

One line, and it keeps a session lookup off every public request in the app.

## Reaching the caller

`AuthContext` is `AsyncLocalStorage`, so a service three constructor hops from the
route sees the principal without it being threaded through a signature:

```ts
export class Audit {
  constructor(private readonly auth: AuthContext) {}

  entries(): readonly string[] {
    const { user } = this.auth.require(); // 401 if there is none
    return this.log.forUser(user.id);
  }
}
```

`current()` returns `Principal | undefined`; `require()` throws a 401.

Two alternatives were rejected. Request-scoped DI was measured and turned down
(`docs/ARCHITECTURE.md`), and hanging the principal off `req` reaches a route handler
but nothing a route handler calls. `AsyncLocalStorage` is a Node built-in Bun
implements natively, and it is already how `@dunx/core` carries request state.

It is a **second** store rather than a key in `RequestContext`, because that one is
the log record - every field in it is serialized into every line the request writes,
so a session object there would be noise on each entry and a redaction hazard in the
ones that matter. What does go there is `userId`, which is why every log line inside a
guarded request is already correlated to the user.

### Plugin types

`Auth` is generic over the options it was built from, the same trick
`@dunx/infra/db` uses for drizzle's schema: the token is the erased class, the type
argument rides on the annotation.

```ts
export const authOptions = { plugins: [admin()], ... } as const;

// `api` here has the admin plugin's endpoints on it.
constructor(private readonly auth: Auth<typeof authOptions>) {}
```

Written bare, `Auth` carries better-auth's core endpoints only.

## Password hashing

better-auth's default hasher is **pure-JavaScript scrypt**. `AuthModule` replaces it
with `bunPassword` - native bcrypt through `Bun.password` - whenever
`emailAndPassword` is enabled and you did not supply a `password` of your own. That is
Rule 1's first half: if Bun ships it, use Bun.

Bun pre-hashes the input, so bcrypt's 72-byte cap is a non-issue even for a
maximum-length multibyte password, and `verify` reads a hash from another algorithm as
a clean authentication failure rather than a 500.

**Migrating an existing user table?** Those users' scrypt hashes will no longer verify
and they will have to reset their passwords. Pass your own `emailAndPassword.password`
to keep the old hasher, or a hybrid that tries both.

## Sessions in Redis

```ts
import { redisStorage } from '@dunx/auth';

AuthModule.forRootAsync({
  useFactory: (redis: RedisConnection) => ({
    secondaryStorage: redisStorage(redis),
    ...
  }),
  inject: [RedisConnection] as const,
});
```

Sessions, verification values and rate-limit counters then live in Redis instead of
costing a database round trip per request.

All five methods are implemented, not the three that are mandatory. `getAndDelete` and
`increment` are optional in better-auth's interface because most clients cannot do
them atomically - `Bun.RedisClient` can, through `GETDEL` and `INCR`. Without them
better-auth falls back to read-then-delete for single-use credentials, which is a
race, and to a non-atomic rate-limit counter.

`redisStorage` takes a `RedisStore`, which is six methods restated rather than
imported - an `@dunx/infra/redis` `RedisConnection` satisfies it structurally, and so
does anything else shaped like `Bun.RedisClient`.

## What is bound

`AuthModule` binds four things and mounts one controller:

| Token         | Resolves to                                                     |
| ------------- | --------------------------------------------------------------- |
| `AuthOptions` | The resolved options, the `basePath`, and the mount path         |
| `Auth`        | The better-auth instance                                        |
| `AuthContext` | The per-request principal store                                 |
| `SessionGuard`| The guard, ready for `middleware: [...]` or `@UseGuards`         |

Every one of them declares its own `inject` list, so none of it needs
`@dunx/transform`'s transform to have run - `@dunx/auth` works in an app with no
preload.
