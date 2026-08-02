# Authentication

better-auth mounted on Bun.serve: the module, the guard and two Bun-native adapters, and nothing of the auth flow itself.

## Authentication (`@dunx/auth`)

**better-auth is the authentication system.** `@dunx/auth` is the wiring around it and
nothing else: no sign-in flow, no session table, no password reset, no OAuth dance.
Never inventing what a mature library solves is not a close call here - an auth
system is years of edge cases,
and a half-built one is a liability dressed as a feature. `better-auth` is an optional
`peerDependency`, as is `drizzle-orm` behind the `@dunx/auth/drizzle` subpath.

### `better-auth` is a required peer, `drizzle-orm` an optional one

`@dunx/auth` exists to mount better-auth, and `module.ts` imports `betterAuth` as a
**value**, so `dist/index.js` cannot load without it. Declaring it
`optional: true` would promise something the build does not honour - a consumer who
skipped it would get a module-resolution crash on import rather than the install-time
warning a required peer produces.

`drizzle-orm` stays optional because only the `@dunx/auth/drizzle` subpath imports
it, and `dist/index.js` contains no reference to it - verified rather than assumed.
That is the same test `@dunx/infra` passes for its five other subpaths: a peer is
optional exactly when the entry point a consumer imports does not need it.

### Why a new package rather than `@dunx/infra/auth`

The guard is `@dunx/http` middleware and reads `@dunx/http`'s `PUBLIC` and `ROLES`
metadata keys, so the code needs `@dunx/http`'s types. `@dunx/infra` must not depend
on the web layer - the same coupling was proposed for a request logger in `/logger`
and refused for the same reason: `@dunx/infra` is what a CLI script, a seeder or a
queue worker imports, and none of those have an HTTP server. A package that pulled
`@dunx/http` in behind `@dunx/infra/db` would put a route table in every one of them.

So the dependency runs the other way: `@dunx/auth` depends on `@dunx/core` and
`@dunx/http`, and on `@dunx/infra` **not at all**.

### And it stays `@dunx/auth`, not `@dunx/better-auth`

Proposed on the grounds that the package is better-auth and nothing else, so the
install line should say so - and that `@dunx/compiler` becoming `@dunx/transform` was
the precedent. **Declined.**

That precedent does not carry. `compiler` was renamed because it **overstated** what
the package is: it is a load-time transform, not a compiler, and the name promised a
thing that did not exist. `auth` overstates nothing. It understates a coupling, which
is a much milder fault and the ordinary one for an integration package.

The decisive argument is consistency, and it cuts the other way from the proposal.
Every dunx integration is named for the **capability**, never the vendor:
`@dunx/infra/db` is drizzle and nothing else, `@dunx/infra/queue` is bullmq and
nothing else, and neither is called `@dunx/drizzle` or `@dunx/bullmq`. Renaming auth
alone would make it the single vendor-named package in the set - a _less_ coherent
scheme, not a more legible one. The vendor belongs in the description, the README and
the peer dependency, where it already is in all three cases.

It also keeps the name from becoming a hostage. A capability name survives replacing
the library behind it; `@dunx/better-auth` would be a dead package the day it did not
wrap better-auth.

The cost of doing it anyway had already stopped being zero: `0.1.0`, `0.1.1` and every
release since are published, so a rename means a deprecation, a republish, and an
edit to every install line in the guides and the scaffolder. Paying that for a naming
preference that is arguably backwards was not worth it. Reopening this needs a reason
other than the name reading oddly.

### Not depending on `@dunx/infra`, while still using its connections

`drizzleDatabase(connection)` and `redisStorage(connection)` are the two adapters that
matter, and both would naturally import `DbConnection` and `RedisConnection`. Neither
does. `DrizzleSource` (`{ dialect, db }`) and `RedisStore` (six methods) are **restated
structurally**, exactly as `@dunx/http` restates Standard Schema and for the same
reasons: `@dunx/infra`'s real classes satisfy them with no adapter in between, a bare
`drizzle({ client, schema })` handle works too, and the package's dependency list
stays at two.

The concrete forcing function was a build-order race. `@dunx/infra` as a
`devDependency` of `@dunx/auth` is not an edge `bun run --filter '*'` orders on, so
`tsc --emitDeclarationOnly` in `@dunx/auth` ran against a `packages/infra/dist` that
had just been `rm -rf`'d. Type-only imports would not have helped - tsc needs the
`.d.ts` either way. Restating removed the edge instead of sequencing it.

`drizzleDatabase` also lives on its **own subpath**, because it imports
`better-auth/adapters/drizzle`, which imports `drizzle-orm`. On the main entry that
would make `drizzle-orm` a hard requirement for a Prisma or MongoDB user.

### The instance is bound under an abstract class

`betterAuth()` returns a plain object, so there is no class to use as a token. `Auth`
is an abstract class whose five members are **aliases of better-auth's own** -
`Instance<O>['handler']`, `Instance<O>['api']`, and so on - which a real instance
satisfies structurally. Same shape as `Logger` and `RequestContext` in `@dunx/core`,
and it is what makes `constructor(private readonly auth: Auth)` work at all.

It is generic over the options, which is the `BunSQLiteDatabase<typeof schema>` trick
again: the token is the erased class, the type argument rides on the annotation, so
`Auth<typeof authOptions>` recovers the plugin-widened `api`. Measured: assigning
`betterAuth(opts)` to `Auth<typeof opts>` typechecks, and **widening `Auth<O>` to
`Auth<BetterAuthOptions>` does not** - `$context` is invariant through
`PluginContext<O>`. So the module narrows the token variable rather than widening the
value, the same move `DbModule` makes with `DbConnection`.

`Auth`'s constructor throws when `new.target` is `Auth` itself, copying
`RedisConnection`: every class self-binds in the container, and an unbound abstract
token would otherwise resolve to an object whose every member is `undefined`.

### Mounting: five wildcard routes, and Bun is still the router

`Bun.serve({ routes })` matches `<basePath>/*` natively - verified on Bun 1.3.14,
including that it does **not** match the bare `<basePath>`, which better-auth has no
endpoint at. `AuthHandler` declares one route per verb (`GET`, `POST`, `PUT`, `PATCH`,
`DELETE`; the last three because a plugin may declare them) and each returns
`auth.handler(req)` untouched. `buildRoutes` passes a `Response` straight through, so
`Set-Cookie` and redirects survive.

The controller is a **subclass** created in `forRoot` - `Controller(basePath)(class
MountedAuthHandler extends AuthHandler {})` - rather than `@Controller` on the shared
class, because the prefix is only known once the module is configured. `discoverRoutes`
walks the prototype chain and `prefixOf` is a plain lookup, so the subclass inherits
the routes and contributes only the prefix.

`AuthHandler` is `@Public()` at class scope. Without it a globally installed
`SessionGuard` would demand a session from the sign-in endpoint, and no session could
ever be created.

### `basePath` and `mountAt` are two strings for one URL

better-auth resolves an endpoint by comparing the **whole pathname** to its own
`basePath` - measured: `baseURL: 'http://host/api'` with `basePath: '/auth'` serving at
`/api/auth/*` answers 404 to everything, so the path in `baseURL` is not consulted.

That collides with `setGlobalPrefix`, which rewrites every discovered route. With
prefix `api` the route has to be `/auth` while better-auth has to be told
`/api/auth`. `AuthModule`'s optional second argument is therefore the **route** path,
and `AuthOptions` carries both. Two knobs, but each has one meaning, and the common
case (no prefix) uses neither.

Both mistakes are caught rather than left silent. An async factory that returns a
non-default `basePath` without a `mountAt` fails at boot. A wrong explicit `mountAt`
cannot be known at boot - the global prefix is applied at `listen()` - so
`AuthHandler` checks the pathname against `basePath` on the **first** request only and
throws an `AuthError` naming both, instead of letting better-auth 404 silently.

### The principal travels in a second async store

`AuthContext` owns an `AsyncLocalStorage<Principal>`; `SessionGuard` runs `next()`
inside it. Two alternatives were rejected: request-scoped DI was measured and turned
down (see **Rejected**), and attaching the principal to `req` reaches a route handler
but nothing a route handler calls - which is the case that matters, since the caller is
usually wanted three constructor hops down.

It is deliberately **not** a key in `@dunx/core`'s `RequestContext`. That store is the
log record: every field in it is serialized into every line the request writes, so a
session object there would be noise on each entry and a redaction hazard in the ones
that matter. `userId` does go there - a well-known `RequestFields` key - which is why
every log line inside a guarded request is already correlated to the user.

### `@Public()` skips the guard outright

The alternative considered was resolving the session best-effort on a public route, so
`AuthContext.current()` would work there. It was dropped: the mounted auth endpoints
are all `@Public()`, so it would have put a duplicate session lookup on the busiest
public path in the app, `get-session` included. A public route that wants an optional
caller calls `auth.api.getSession({ headers: req.headers })` - one line, explicit, and
it costs nothing anywhere else.

### `Bun.password` replaces better-auth's scrypt

better-auth's default hasher is a **pure-JavaScript scrypt**; `AuthModule` substitutes
native bcrypt through `Bun.password` whenever `emailAndPassword` is enabled and no
`password` was supplied. Bun's own primitive rather than a library, and it is what
`nestjs-template/src/auth/auth.config.ts` already does. Bun pre-hashes the input, so
bcrypt's 72-byte cap is a non-issue even for a maximum-length multibyte password, and
`verify` swallows Bun's `UnsupportedAlgorithm` throw so a hash from another algorithm
is a clean 401 rather than a 500. The cost is recorded in the README: an existing
scrypt-hashed user table needs password resets, or its own `password` implementation.

### `redisStorage` implements the atomic pair the reference could not

better-auth's `secondaryStorage` marks `getAndDelete` and `increment` optional because
most clients cannot do them atomically. `Bun.RedisClient` can, through `GETDEL` and
`INCR`, both already on `@dunx/infra/redis`'s contract - so all five methods are
implemented rather than the three that are mandatory. Without them better-auth falls
back to read-then-delete for single-use credentials, which is a race, and to a
non-atomic rate-limit counter. `increment`'s TTL is applied only when `INCR` returns
`1`, which is what makes the window fixed rather than sliding.

Redis being unreachable is deliberately not softened: a swallowed `null` from `get`
reads as "no session" and would sign every user out.

### No schema, on purpose

The four better-auth tables are better-auth's, they change with the plugins an app
enables, and its own CLI generates them (`bunx @better-auth/cli generate`). A copy
inside dunx is a copy that rots against the library that reads it. `examples/full` has
a generated one at `src/database/auth.schema.ts`, re-exported into the app's single
schema object - which is all `drizzleDatabase(connection)` needs, because
`@dunx/infra/db` builds its handle with `drizzle({ client, schema })` and the adapter
reads `db._.fullSchema`.

Two findings from building that fixture, both worth remembering: `db.run(sql\`…\`)`goes through`bun:sqlite`'s `prepare`, which compiles **one** statement and silently
drops what follows the first semicolon - four `CREATE TABLE`s in one template gives
one table. And better-auth rejects a cookie-bearing state change with no `Origin`
header (`MISSING_OR_NULL_ORIGIN`), so a server-side client has to send one matching
`trustedOrigins`; a browser does it for free.
