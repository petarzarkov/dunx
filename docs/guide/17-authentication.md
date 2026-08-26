# Authentication

**better-auth is the authentication system.** `@dunx/auth` is the wiring around it
and nothing else: no sign-in flow, no session table, no password reset, no OAuth
dance.

That is not a close call. An auth system is years of edge cases, and a half-built
one is a liability dressed as a feature. What `@dunx/auth` contributes is the
module, the mount, a guard that reads `@dunx/http`'s existing metadata, the caller
in async context, and two Bun-native adapters.

```bash
bun add better-auth
```

`better-auth` is a **required** peer dependency, because `module.ts` imports
`betterAuth` as a value and `dist/index.js` cannot load without it. `drizzle-orm`
is optional, because only the `@dunx/auth/drizzle` subpath imports it. That is the
same test every optional peer in dunx passes: a peer is optional exactly when the
entry point a consumer imports does not need it.

## Setup

```ts
import { AuthModule, bunPassword } from '@dunx/auth';
import { drizzleDatabase } from '@dunx/auth/drizzle';
import { Module } from '@dunx/core';
import { DbConnection } from '@dunx/infra/db';
import { admin, bearer } from 'better-auth/plugins';
import { AppConfigService } from '../config.js';
import { ProfileController } from './profile.controller.js';

@Module({
  imports: [
    AuthModule.forRootAsync(
      {
        useFactory: (config: AppConfigService, connection: DbConnection) => ({
          secret: config.get('auth').secret,
          baseURL: `http://localhost:${config.get('port')}`,
          basePath: '/api/auth',
          database: drizzleDatabase(connection),
          emailAndPassword: {
            enabled: true,
            minPasswordLength: 8,
            password: bunPassword,
          },
          plugins: [admin(), bearer()],
        }),
        inject: [AppConfigService, DbConnection] as const,
      },
      '/auth',
    ),
  ],
  controllers: [ProfileController],
})
export class AccountsModule {}
```

The synchronous form is the same shape without the factory:

```ts
AuthModule.forRoot({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: 'http://localhost:3000',
  database: drizzleDatabase(connection),
  emailAndPassword: { enabled: true },
  plugins: [admin(), bearer()],
});
```

`const O` on `forRoot`'s type parameter is load-bearing: it keeps the literal
`plugins` tuple that `betterAuth()` infers the plugin endpoints from, and
therefore what `Auth<typeof options>` resolves to at an injection site.

### What it binds

| Token          | What it is                                                   |
| -------------- | ------------------------------------------------------------ |
| `AuthOptions`  | What `betterAuth()` was called with, and where it is mounted |
| `Auth`         | The better-auth instance itself                              |
| `AuthContext`  | The authenticated caller, per request                        |
| `SessionGuard` | Registered as a provider, **not** installed for you          |

Plus one controller: a prefixed `AuthHandler` serving every better-auth endpoint
under `basePath`.

`SessionGuard` is a provider rather than global middleware because whether it
guards the whole app or one controller is the app's decision to make.

### Reaching the caller from a second module

`AuthModule` exports those four tokens **to the module that imported it**, which is
the `AccountsModule` above. A second feature module that injects `AuthContext` gets
a boot error, and calling `forRootAsync` again there would build a second
better-auth against a second session store.

Pass them on instead, the way any module re-exports what it imported:

```ts
@Module({
  imports: [AuthModule.forRootAsync({ ... }, '/auth')],
  controllers: [ProfileController],
  exports: [Auth, AuthContext, SessionGuard],
})
export class AccountsModule {}
```

Now `imports: [AccountsModule]` reaches them. Add `global: true` to that options
object when enough modules need the caller that naming the import everywhere is the
larger cost.

The boot error names both fixes and the module that has the binding, so getting
this wrong is a one-read fix rather than a hunt:

```
Cannot resolve Auth in module "UsersModule". "AuthModule" declares it, but
"UsersModule" does not import it. Add that module to "UsersModule"'s imports,
or give it `global: true`.
```

## Mounting on `Bun.serve`

better-auth's handler is a plain `(request: Request) => Promise<Response>`, so
mounting it is five one-line routes and nothing else:

```ts
@Public()
export class AuthHandler {
  readonly #auth = inject(Auth);

  @Get('/*') get({ req }: Input<RouteSchemas>): Promise<Response> {
    /* ... */
  }
  @Post('/*') post({ req }: Input<RouteSchemas>): Promise<Response> {
    /* ... */
  }
  // Put, Patch, Delete too
}
```

`Bun.serve({ routes })` matches `<basePath>/*` **natively**, verified on Bun
1.3.14, including that it does not match the bare `<basePath>`, which better-auth
has no endpoint at. So Bun is still the router: there is no JavaScript dispatch
table in front of it, and dunx does not restate, wrap or re-dispatch a single one
of better-auth's endpoints.

All five verbs are mounted because a plugin may declare any of them; better-auth's
own endpoints are `GET` and `POST`. The `Response` is returned untouched, which is
what keeps `Set-Cookie` headers and redirects intact.

`AuthHandler` is `@Public()` **at class scope**. Without it, a globally installed
`SessionGuard` would demand a session from the sign-in endpoint, and no session
could ever be created.

The controller `AuthModule` registers is a **subclass** created in `forRoot`,
rather than `@Controller(...)` on `AuthHandler` itself, because the prefix is only
known once the module is configured, and mutating the shared class from a factory
would make two configurations fight over one prefix.

### `basePath` and `mountAt`

better-auth resolves an endpoint by comparing the **whole pathname** to its own
`basePath`. Measured: `baseURL: 'http://host/api'` with `basePath: '/auth'` served
at `/api/auth/*` answers 404 to everything, so the path in `baseURL` is not
consulted.

That gives you two knobs, each with one meaning:

- **`basePath`** in the options is what better-auth matches against.
- **`mountAt`**, the second argument to `forRoot`/`forRootAsync`, is the **route**
  path in Bun's table.

They are the same string unless the app calls `setGlobalPrefix`. With prefix
`api`, the route has to be `/auth` while better-auth has to be told `/api/auth`:

```ts
AuthModule.forRoot({ basePath: '/api/auth' /* ... */ }, '/auth');
app.setGlobalPrefix('api');
```

The common case, no prefix, uses neither.

`mountAt` is a **synchronous** second argument on `forRootAsync` for the same
reason `DbModule.forRootAsync` takes its token positionally: the mount is a route
in Bun's table, and that table is built before any factory has run. Omitting it
while the factory returns a non-default `basePath` is a boot error, because that
combination could only ever have mounted the handler where better-auth is not
looking.

A wrong **explicit** `mountAt` cannot be known at boot, since the final path is
only settled once `listen()` has applied the global prefix. So `AuthHandler`
checks the pathname against `basePath` on the **first** request only, and throws
an `AuthError` naming both.

## `Auth`, the injection token

`betterAuth()` returns a plain object, so there is no class to use as a token.
`Auth` is an abstract class whose members are **aliases of better-auth's own**,
not restatements, which a real instance satisfies structurally. Same shape as
`Logger` and `RequestContext` in `@dunx/core`.

```ts
export class Profiles {
  constructor(private readonly auth: Auth) {}

  async whoIs(headers: Headers) {
    return this.auth.api.getSession({ headers });
  }
}
```

The type argument is the `DbModule` trick again: the token is the erased class, so
`Auth<typeof authOptions>` at an injection site keeps the plugin-widened `api`
while still resolving the one binding. Written bare, `Auth` carries better-auth's
core endpoints only.

Measured: assigning `betterAuth(opts)` to `Auth<typeof opts>` typechecks, and
widening `Auth<O>` to `Auth<BetterAuthOptions>` does not, because `$context` is
invariant through `PluginContext<O>`. So the module narrows the token variable
rather than widening the value.

`Auth`'s constructor throws when `new.target` is `Auth` itself. Every class
self-binds in the container, so an unbound abstract token would otherwise resolve
to an object whose every member is `undefined`, and the first symptom would be
`auth.handler is not a function` deep inside a request.

## `SessionGuard`

```ts
export class SessionGuard implements Middleware {
  async handle(
    req: BunRequest,
    ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    if (ctx.get(PUBLIC)) return next();

    const principal = await this.auth.api.getSession({ headers: req.headers });
    if (!principal)
      throw new HttpError(HttpStatusCode.UNAUTHORIZED, 'UNAUTHENTICATED');

    const required = ctx.get(ROLES);
    if (required?.length) {
      const held = rolesOf(principal.user);
      if (!required.some((role) => held.includes(role))) {
        throw new HttpError(
          HttpStatusCode.FORBIDDEN,
          `Requires one of: ${required.join(', ')}`,
        );
      }
    }

    return this.context.run(principal, next);
  }
}
```

Two ways to install it, and `AuthModule` registers it either way:

```ts
// Globally: everything is guarded, opt routes out with @Public()
HttpFactory.create(AppModule, { middleware: [SessionGuard] });

// Scoped: leave the rest of the app open
@UseGuards(SessionGuard)
export class ReportsController {}
```

### `@Public()`

A `@Public()` route is **skipped outright**. No session lookup, no rejection, no
role check. Global installation is safe for that reason: better-auth's own
endpoints are `@Public()`, and a sign-in route that needed a session could never
be reached.

Best-effort session resolution on public routes was considered and dropped,
because the mounted auth endpoints are all `@Public()` and it would have put a
duplicate session lookup on the busiest public path in the app, `get-session`
included.

A public route that wants to **adapt** to an optional caller injects `Auth` and
calls `auth.api.getSession({ headers: req.headers })` itself. One line, and it
does not put a lookup on every public request.

### `@Roles()`

```ts
@Roles('admin')
@Get('/reports')
list() { /* 403 unless the caller holds 'admin' */ }
```

`rolesOf(user)` reads both shapes better-auth produces. The `admin` plugin stores
roles in a single `role` column, comma-separated for more than one; a custom
plugin may use an array. A user with no roles reads as `[]` rather than throwing,
since an app may well not use roles at all.

`@Public()` and `@Roles()` are `@dunx/http`'s own metadata rather than
auth-specific decorators. `SessionGuard` composes with what the routes already carry.

## `AuthContext`

How the authenticated caller reaches a handler, and anything the handler calls,
however deep.

```ts
export class Notes {
  constructor(private readonly auth: AuthContext) {}

  create(body: string): Note {
    const { user } = this.auth.require();
    return { ownerId: user.id, body };
  }
}
```

- `current<O>()` returns the principal, or `undefined` on an anonymous request.
- `require<O>()` returns it or throws a 401. For a handler behind `SessionGuard`
  that is not `@Public()`.
- `run(principal, callback)` runs `callback` with that caller. `SessionGuard`
  calls this; a job or a socket handler that resolved a session itself can too.

A `Principal` is `{ session, user }`, so the caller is one field down: `require().id`
is `undefined` and `require().user.id` is the id.

The type argument surfaces a plugin's extra user fields, on `current` and `require`
alike. `admin()` puts `role` on the user, which is the line a role check is built
from:

```ts
const principal = this.auth.current<typeof authOptions>();

// Without the type argument, `role` is not on the type: `user` is better-auth's
// base user.
const isAdmin = this.auth.require<typeof authOptions>().user.role === 'admin';
```

### Why a second async store

`AuthContext` owns its own `AsyncLocalStorage<Principal>`, separate from
`@dunx/core`'s `RequestContext`.

`AsyncLocalStorage` at all, for the same reason core's `RequestContext` uses it:
a Node built-in Bun implements natively, and the only mechanism that gets a value
from middleware to a service three constructor hops away without passing it.

Both alternatives were worse. Request-scoped DI was measured and rejected, and
hanging the principal off `req` reaches a route handler but nothing a route
handler calls.

A **second** store rather than a key in `RequestContext`, because that store is
the log record. Every field in it is serialized into every line the request
writes, so a session object there would be noise on each entry and a redaction
hazard in the ones that matter.

What does go there is `userId`, a well-known `RequestFields` key, written by
`run()`. So the log lines are correlated without carrying the principal. See
[Logging](./13-logging.md).

## `Bun.password` hashing

better-auth's default hasher is a **pure-JavaScript scrypt**. `AuthModule`
substitutes native bcrypt through `Bun.password` whenever `emailAndPassword` is
enabled and no `password` of your own was supplied:

```ts
export const bunPassword = {
  hash: (password: string) =>
    Bun.password.hash(password, { algorithm: 'bcrypt', cost: 10 }),
  verify: async ({ hash, password }) => {
    try {
      return await Bun.password.verify(password, hash);
    } catch {
      return false;
    }
  },
};
```

Naming it explicitly, as the example above does, changes nothing; it just makes
the substitution visible.

Bun pre-hashes the input, so bcrypt's **72-byte cap is a non-issue** even for a
maximum-length multibyte password.

`verify` swallows Bun's `UnsupportedAlgorithm` throw, so a hash produced by a
different algorithm - a scrypt hash written before this was in place - is a clean
authentication failure rather than a 500.

**The cost, stated plainly:** those users must reset their password to get a
bcrypt hash. If you are migrating an existing user table and cannot make them,
pass your own `password` implementation instead.

## The two adapters

### `drizzleDatabase(connection)`

better-auth's `database` option over a connection the app **already opened**:

```ts
import { drizzleDatabase } from '@dunx/auth/drizzle';

AuthModule.forRootAsync({
  useFactory: (connection: DbConnection) => ({
    database: drizzleDatabase(connection),
  }),
  inject: [DbConnection],
});
```

Nothing here connects. The point is that the app keeps **one** pool, one SQLite
handle and one shutdown path, instead of better-auth opening a second.

The `provider` comes from the connection's own dialect, so swapping `bun:sqlite`
for `Bun.SQL` needs no edit at the call site. The schema does not have to be
passed either: `@dunx/infra/db` builds its handle with `drizzle({ client, schema })`
and the adapter reads `db._.fullSchema`, so the better-auth tables being in the
app's schema object is the whole requirement.

It lives on **its own subpath** because it imports
`better-auth/adapters/drizzle`, which imports `drizzle-orm`. On the main entry
that would make `drizzle-orm` a hard requirement for a Prisma or MongoDB user.

### `redisStorage(connection)`

better-auth's `secondaryStorage` over `Bun.RedisClient`, so sessions, verification
values and rate-limit counters live in Redis instead of costing a database round
trip on every request:

```ts
import { redisStorage } from '@dunx/auth';
import { RedisConnection } from '@dunx/infra/redis';

AuthModule.forRootAsync({
  useFactory: (redis: RedisConnection) => ({
    secondaryStorage: redisStorage(redis),
  }),
  inject: [RedisConnection],
});
```

**All five methods are implemented, beyond the three that are mandatory.**
better-auth marks `getAndDelete` and `increment` optional because most clients
cannot do them atomically. `Bun.RedisClient` can, through `GETDEL` and `INCR`.
Without them, better-auth falls back to read-then-delete for single-use
credentials, which is a race, and to a non-atomic rate-limit counter.

`increment`'s TTL is applied only when `INCR` returns `1`, keeping the window
fixed rather than sliding forever. A return of `1` signals that this call created
the key.

Redis being unreachable is **not** softened. Bun's client connects
lazily and queues, so a command against a down server rejects and better-auth's
own error path is what should see it. A swallowed `null` from `get` would read as
"no session" and sign every user out.

## Why these restate structurally

`drizzleDatabase` and `redisStorage` would naturally import `DbConnection` and
`RedisConnection` from `@dunx/infra`. Neither does. `DrizzleSource` and
`RedisStore` are restated as small structural interfaces:

```ts
export interface DrizzleSource {
  readonly dialect: 'postgres' | 'mysql' | 'mariadb' | 'sqlite';
  readonly db: unknown;
}

export interface RedisStore {
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<boolean>;
  set(
    key: string,
    value: string,
    options?: { readonly ex?: number },
  ): Promise<string | null>;
  del(key: string): Promise<number>;
}
```

An `@dunx/infra/db` connection satisfies the first with no adapter in between, and
a `RedisConnection` satisfies the second because its parameters are wider, which
is the assignable direction. A bare `drizzle({ client, schema })` handle works
too, and a test double is six methods instead of a whole surface.

Two reasons, and the second is the concrete one.

**The web layer boundary.** `@dunx/auth` is its own package because the guard is
`@dunx/http` middleware and reads `@dunx/http`'s `PUBLIC` and `ROLES` metadata
keys.

`@dunx/infra` must not depend on the web layer: it is what a CLI script, a seeder
or a queue worker imports, and none of those have an HTTP server. A package that
pulled `@dunx/http` in behind `@dunx/infra/db` would put a route table in every
one of them. The dependency runs the other way, and `@dunx/auth` depends on
`@dunx/infra` **not at all**.

**A build-order race.** `@dunx/infra` as a `devDependency` of `@dunx/auth` is not
an edge `bun run --filter '*'` orders on, so `tsc --emitDeclarationOnly` in
`@dunx/auth` ran against a `packages/infra/dist` that had just been `rm -rf`'d.
Type-only imports would not have helped, because tsc needs the `.d.ts` either
way. Restating **removed the edge** instead of sequencing it.

## No schema

dunx ships **no** schema for better-auth's tables. They are better-auth's, they
change with its plugins, and its own CLI generates them:

```bash
bunx @better-auth/cli generate
```

A copy of them inside a framework is a copy that silently rots against the library
that reads it.

Two things learned while building the test fixture, which apply if you create
those tables by hand:

- ``db.run(sql`...`)`` goes through `bun:sqlite`'s `prepare`, which compiles
  **one** statement and silently drops what follows the first semicolon. Four
  `CREATE TABLE`s in one template gives one table, with no error.
- better-auth rejects a cookie-bearing state change with no `Origin` header
  (`MISSING_OR_NULL_ORIGIN`), so a server-side client has to send one matching
  `trustedOrigins`. A browser does it for free.

## Related

- [Database](./14-database.md) for the connection `drizzleDatabase` reuses
- [Logging](./13-logging.md) for the `RequestContext` that carries `userId`
- [Configuration](./12-configuration.md) for `forRootAsync` and `AppConfigService`
- `packages/auth/README.md` for the full API surface
