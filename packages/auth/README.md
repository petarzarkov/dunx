# @dunx/auth

[Better Auth](https://better-auth.com) for
[dunx](https://github.com/petarzarkov/dunx).

This package connects better-auth to dunx. It gives you a module that builds the
better-auth instance from your `ConfigService`, five routes that mount its
handler, a guard that respects `@dunx/http`'s `@Public()` and `@Roles()`, and
two adapters that run better-auth on Bun's own APIs.

better-auth handles authentication itself; this package does not reimplement
it.

There is no dunx sign-in flow, no dunx session table and no dunx OAuth. Each is
a better-auth feature reached through `AuthModule.forRoot`'s options, which
**are** better-auth's `BetterAuthOptions`.

## Install

```bash
bun add @dunx/auth better-auth
```

`better-auth` is a **required** peer: this package imports `betterAuth` as a
value and cannot load without it. `drizzle-orm` is an optional peer, needed only
by `@dunx/auth/drizzle` - its own subpath so a Prisma, Kysely or MongoDB app
never loads it.

## Usage

```ts
import { AuthModule, SessionGuard } from '@dunx/auth';
import { drizzleDatabase } from '@dunx/auth/drizzle';
import { Module } from '@dunx/core';
import { HttpFactory } from '@dunx/http';
import { DbConnection } from '@dunx/infra/db';

@Module({
  imports: [
    AuthModule.forRootAsync({
      imports: [DatabaseModule],
      inject: [AppConfigService, DbConnection],
      useFactory: (config: AppConfigService, connection: DbConnection) => ({
        secret: config.get('auth').secret,
        basePath: '/api/auth',
        database: drizzleDatabase(connection),
        emailAndPassword: { enabled: true },
      }),
    }),
  ],
})
export class AuthFeatureModule {}

// Globally, and opt routes out with @Public():
HttpFactory.create(AppModule, { middleware: [SessionGuard] });
```

## What is here

The [Authentication guide](../../docs/guide/17-authentication.md) is canonical.

| Export                | What it does                                                    |
| --------------------- | ----------------------------------------------------------------- |
| `AuthModule`          | Builds the instance, mounts the handler, binds the guard          |
| `Auth`                | The better-auth instance, injectable                              |
| `SessionGuard`        | Authenticates, honours `@Public()` and `@Roles()`                 |
| `AuthContext`         | The authenticated caller, anywhere in the request                 |
| `betterAuthDocument`  | better-auth's own paths merged into the OpenAPI document          |
| `bunPassword`         | `Bun.password` native bcrypt, applied by default                  |
| `@dunx/auth/drizzle`  | better-auth over the connection the app already opened            |
| `redisStorage`        | `secondaryStorage` over `Bun.RedisClient`                         |

## Notes

- dunx does not ship a schema for better-auth's tables, because better-auth
  owns them and they change with its plugins. Generate them with
  `bunx @better-auth/cli generate`, and export them under the singular model
  names the adapter looks up.
- Under `setGlobalPrefix`, `basePath` is what better-auth matches. `mountAt`
  is where the route is mounted. Omitting `mountAt` with a non-default
  `basePath` is a boot error.
- `AuthContext` is a second `AsyncLocalStorage` store rather than a key in
  `RequestContext`. Everything in that store is serialized into every log
  line the request writes.

## License

MIT
