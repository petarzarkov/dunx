import { Module, inject, provide } from '@dunx/core';
import {
  Controller,
  Get,
  HttpFactory,
  Public,
  Roles,
  type HttpApp,
  type Input,
  type RouteSchemas,
} from '@dunx/http';
import { admin, bearer } from 'better-auth/plugins';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { Auth } from './auth.js';
import { AuthContext } from './context.js';
import { drizzleDatabase, type DrizzleSource } from './drizzle.js';
import { rolesOf, SessionGuard } from './guard.js';
import { AuthModule } from './module.js';

/**
 * The better-auth tables, as its own CLI would generate them for
 * `drizzle-orm/sqlite-core` with the `admin` plugin enabled. dunx ships no copy of
 * this - see `drizzleDatabase` - so the fixture is here for the same reason an app
 * would have one.
 */
const timestamp = () =>
  integer({ mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date());

const user = sqliteTable('user', {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: integer({ mode: 'boolean' }).notNull().default(false),
  image: text(),
  role: text(),
  banned: integer({ mode: 'boolean' }),
  banReason: text(),
  banExpires: integer({ mode: 'timestamp_ms' }),
  createdAt: timestamp(),
  updatedAt: timestamp(),
});

const session = sqliteTable('session', {
  id: text().primaryKey(),
  token: text().notNull().unique(),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
  ipAddress: text(),
  userAgent: text(),
  impersonatedBy: text(),
  createdAt: timestamp(),
  updatedAt: timestamp(),
});

const account = sqliteTable('account', {
  id: text().primaryKey(),
  accountId: text().notNull(),
  providerId: text().notNull(),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text(),
  refreshToken: text(),
  idToken: text(),
  accessTokenExpiresAt: integer({ mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer({ mode: 'timestamp_ms' }),
  scope: text(),
  password: text(),
  createdAt: timestamp(),
  updatedAt: timestamp(),
});

const verification = sqliteTable('verification', {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
  createdAt: timestamp(),
  updatedAt: timestamp(),
});

const schema = { user, session, account, verification };

const DDL = `
  CREATE TABLE user (
    id text PRIMARY KEY NOT NULL, name text NOT NULL, email text NOT NULL UNIQUE,
    emailVerified integer DEFAULT 0 NOT NULL, image text, role text,
    banned integer, banReason text, banExpires integer,
    createdAt integer NOT NULL, updatedAt integer NOT NULL);
  CREATE TABLE session (
    id text PRIMARY KEY NOT NULL, token text NOT NULL UNIQUE,
    userId text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    expiresAt integer NOT NULL, ipAddress text, userAgent text,
    impersonatedBy text, createdAt integer NOT NULL, updatedAt integer NOT NULL);
  CREATE TABLE account (
    id text PRIMARY KEY NOT NULL, accountId text NOT NULL, providerId text NOT NULL,
    userId text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    accessToken text, refreshToken text, idToken text,
    accessTokenExpiresAt integer, refreshTokenExpiresAt integer,
    scope text, password text,
    createdAt integer NOT NULL, updatedAt integer NOT NULL);
  CREATE TABLE verification (
    id text PRIMARY KEY NOT NULL, identifier text NOT NULL, value text NOT NULL,
    expiresAt integer NOT NULL, createdAt integer NOT NULL, updatedAt integer NOT NULL);
`;

/**
 * A `DrizzleSource`, which is the shape `@dunx/infra/db`'s `DbConnection` has. Bound
 * as a token so `forRootAsync` has something to inject, exactly as the full example
 * injects the real `DbConnection`.
 */
class Connection implements DrizzleSource {
  readonly dialect = 'sqlite';
  readonly raw = new Database(':memory:', { strict: true });
  readonly db = drizzle({ client: this.raw, schema });
}

/**
 * Behind the guard. `whoami` proves the principal reached a handler; `admins` proves
 * `@Roles` still decides; `open` proves `@Public` skips the guard outright and
 * `maybe` shows what a public route does when it wants an optional caller.
 */
@Controller('secrets')
class SecretsController {
  readonly #auth = inject(AuthContext);
  readonly #instance = inject(Auth);

  @Get('/whoami') whoami(): { email: string; roles: readonly string[] } {
    const principal = this.#auth.require();
    return { email: principal.user.email, roles: rolesOf(principal.user) };
  }

  @Roles('admin')
  @Get('/admins')
  admins(): { ok: true } {
    return { ok: true };
  }

  @Public()
  @Get('/open')
  open(): { caller: string | null } {
    return { caller: this.#auth.current()?.user.email ?? null };
  }

  /** What a public route does when it wants an optional caller: ask better-auth. */
  @Public()
  @Get('/maybe')
  async maybe(input: Input<RouteSchemas>): Promise<{ caller: string | null }> {
    const principal = await this.#instance.api.getSession({
      headers: input.req.headers,
    });
    return { caller: principal?.user.email ?? null };
  }
}

/**
 * The database the factory injects lives in its own module and is exported, and the
 * factory names that module through `imports`. Both are required now: the provider
 * `forRootAsync` configures is registered in `AuthModule`'s scope, so a token only
 * this file's module declares is not something `AuthModule` can see.
 */
@Module({
  providers: [provide(Connection, { useFactory: () => new Connection() })],
  exports: [Connection],
})
class DatabaseModule {}

@Module({
  imports: [
    DatabaseModule,
    AuthModule.forRootAsync({
      imports: [DatabaseModule],
      useFactory: (connection: Connection) => ({
        secret: 'a-test-secret-of-at-least-32-characters',
        baseURL: 'http://localhost',
        database: drizzleDatabase(connection),
        emailAndPassword: { enabled: true },
        plugins: [admin(), bearer()],
      }),
      inject: [Connection] as const,
    }),
  ],
  controllers: [SecretsController],
})
class TestApp {}

let app: HttpApp;
let base: string;
let raw: Database;

const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const cookieOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0])
    .join('; ');

beforeAll(async () => {
  app = await HttpFactory.create(TestApp, {
    middleware: [SessionGuard],
    requestLogging: false,
  });
  base = (await app.listen(0)).replace(/\/$/, '');
  // The tables, created on the very handle the app opened. Nothing has queried yet:
  // `betterAuth()` builds no adapter until the first request.
  raw = app.get(Connection).raw;
  raw.exec(DDL);
});

afterAll(async () => {
  await app.shutdown();
  raw.close();
});

describe('AuthModule', () => {
  it('mounts better-auth under the default basePath', async () => {
    const response = await fetch(`${base}/api/auth/ok`);
    expect(response.status).toBe(200);
  });

  it('rejects an unauthenticated request to a guarded route', async () => {
    const response = await fetch(`${base}/secrets/whoami`);
    expect(response.status).toBe(401);
  });

  it('signs up, signs in and reaches a guarded route with the cookie', async () => {
    const signUp = await post('/api/auth/sign-up/email', {
      email: 'ada@example.com',
      password: 'password123',
      name: 'Ada',
    });
    expect(signUp.status).toBe(200);

    const signIn = await post('/api/auth/sign-in/email', {
      email: 'ada@example.com',
      password: 'password123',
    });
    expect(signIn.status).toBe(200);

    const cookie = cookieOf(signIn);
    expect(cookie).toContain('better-auth.session_token=');

    const whoami = await fetch(`${base}/secrets/whoami`, {
      headers: { cookie },
    });
    expect(whoami.status).toBe(200);
    expect(await whoami.json()).toEqual({
      email: 'ada@example.com',
      roles: ['user'],
    });
  });

  it('authenticates with the bearer plugin token as well', async () => {
    const signIn = await post('/api/auth/sign-in/email', {
      email: 'ada@example.com',
      password: 'password123',
    });
    const token = signIn.headers.get('set-auth-token');
    expect(token).not.toBeNull();

    const whoami = await fetch(`${base}/secrets/whoami`, {
      headers: { authorization: `Bearer ${token ?? ''}` },
    });
    expect(whoami.status).toBe(200);
  });

  it('hashes the password with Bun.password by default', () => {
    const stored = raw
      .query<{ password: string | null }, []>(
        "SELECT password FROM account WHERE providerId = 'credential'",
      )
      .get();
    // `$2b$` is bcrypt. better-auth's own default would be a scrypt digest.
    expect(stored?.password).toStartWith('$2b$');
  });

  it('403s when @Roles is not satisfied, and passes once it is', async () => {
    const signIn = await post('/api/auth/sign-in/email', {
      email: 'ada@example.com',
      password: 'password123',
    });
    const cookie = cookieOf(signIn);

    const denied = await fetch(`${base}/secrets/admins`, {
      headers: { cookie },
    });
    expect(denied.status).toBe(403);

    raw.run(
      "UPDATE user SET role = 'admin,user' WHERE email = 'ada@example.com'",
    );

    const allowed = await fetch(`${base}/secrets/admins`, {
      headers: { cookie },
    });
    expect(allowed.status).toBe(200);
  });

  it('skips @Public routes outright - no session, even with a cookie', async () => {
    const anonymous = await fetch(`${base}/secrets/open`);
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toEqual({ caller: null });

    const signIn = await post('/api/auth/sign-in/email', {
      email: 'ada@example.com',
      password: 'password123',
    });
    const cookie = cookieOf(signIn);
    const named = await fetch(`${base}/secrets/open`, { headers: { cookie } });
    expect(await named.json()).toEqual({ caller: null });

    // A public route that wants the caller asks better-auth for it.
    const asked = await fetch(`${base}/secrets/maybe`, { headers: { cookie } });
    expect(await asked.json()).toEqual({ caller: 'ada@example.com' });
  });

  it('signs out, after which the cookie no longer authenticates', async () => {
    const signIn = await post('/api/auth/sign-in/email', {
      email: 'ada@example.com',
      password: 'password123',
    });
    const cookie = cookieOf(signIn);

    const signOut = await post('/api/auth/sign-out', {}, { cookie });
    expect(signOut.status).toBe(200);

    const after = await fetch(`${base}/secrets/whoami`, {
      headers: { cookie },
    });
    expect(after.status).toBe(401);
  });

  it('binds the instance under Auth, with its api reachable', async () => {
    const auth = app.get(Auth);
    const listed = await auth.api.getSession({ headers: new Headers() });
    expect(listed).toBeNull();
    expect(auth.options.basePath).toBe('/api/auth');
  });
});
