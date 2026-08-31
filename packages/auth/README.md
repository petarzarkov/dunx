# @dunx/auth

[Better Auth](https://better-auth.com) for
[dunx](https://github.com/petarzarkov/dunx).

This package wires better-auth into dunx: a module that builds the instance
from your `ConfigService`, five routes that mount its handler, a guard that
composes with the `@Public()` and `@Roles()` metadata `@dunx/http` already
carries, and two adapters that let it drive Bun's own APIs.

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
import { AuthModule } from '@dunx/auth';
import { drizzleDatabase } from '@dunx/auth/drizzle';
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
| `@dunx/auth/redis`    | `secondaryStorage` over `Bun.RedisClient`                         |

## Notes

- dunx ships no schema for better-auth's tables: they belong to better-auth
  and change with its plugins. `bunx @better-auth/cli generate` writes them.
  Export them under the singular model names the adapter looks up.
- Under `setGlobalPrefix`, `basePath` is what better-auth matches. `mountAt`
  is where the route is mounted. Omitting `mountAt` with a non-default
  `basePath` is a boot error.
- `AuthContext` is a second `AsyncLocalStorage` store rather than a key in
  `RequestContext`. Everything in that store is serialized into every log
  line the request writes.

## License

MIT
