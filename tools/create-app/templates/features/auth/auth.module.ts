import { Auth, AuthModule, bunPassword } from '@dunx/auth';
import { drizzleDatabase } from '@dunx/auth/drizzle';
import { Module } from '@dunx/core';
import { DbConnection } from '@dunx/infra/db';
import { admin, bearer, openAPI } from 'better-auth/plugins';
import { AppConfigService } from '../config.js';
import { DatabaseModule } from '../database/database.module.js';
import { AuthDemo } from './auth.demo.js';
import { AuthTables } from './auth.tables.js';
import { Audit } from './audit.service.js';
import { ProfileController } from './profile.controller.js';

/** Named for the feature rather than the package, so `AuthModule` still means `@dunx/auth`'s. */
@Module({
  imports: [
    // The drizzle handle, for `AuthTables` and `Audit`.
    DatabaseModule,
    // `forRootAsync` because the secret and the base URL come from the validated
    // config, and the database from the connection `DatabaseModule` already opened -
    // none of which a zero-argument factory could reach.
    AuthModule.forRootAsync(
      {
        // `DbConnection` comes from DatabaseModule, and the provider this factory
        // configures lives in AuthModule's scope - so the module it comes from has to
        // be named. `AppConfigService` needs no naming: ConfigModule is global.
        imports: [DatabaseModule],
        useFactory: (config: AppConfigService, connection: DbConnection) => ({
          secret: config.get('auth').secret,
          baseURL: `http://localhost:${config.get('port')}`,
          // What better-auth matches an incoming pathname against. `app.setGlobalPrefix('api')`
          // is what makes the mounted `/auth` route answer here.
          basePath: '/api/auth',
          // The app's one drizzle handle. No second pool, no second SQLite file, and
          // the connection still closes exactly once, last.
          database: drizzleDatabase(connection),
          // `password: bunPassword` is what `AuthModule` would apply anyway when
          // `emailAndPassword` is on and no hasher is given - named here so it is
          // visible. better-auth's own default is a pure-JavaScript scrypt;
          // `bunPassword` is `Bun.password`'s native bcrypt, which is Rule 1's
          // first half. Bun pre-hashes, so bcrypt's 72-byte cap is a non-issue.
          emailAndPassword: {
            enabled: true,
            minPasswordLength: 8,
            password: bunPassword,
          },
          // `admin` puts `role` on the user, which `@Roles()` then reads. `bearer`
          // lets a non-browser client send `Authorization: Bearer <token>` instead of
          // a cookie - which is what the tour does.
          // `openAPI()` is what makes `generateOpenAPISchema` exist, and
          // `betterAuthDocument` in bootstrap.ts is what puts its paths in the app's
          // document. `disableDefaultReference` because dunx already serves an
          // explorer at /api/docs and two reference pages is one too many.
          plugins: [
            admin(),
            bearer(),
            openAPI({ disableDefaultReference: true }),
          ],
        }),
        inject: [AppConfigService, DbConnection] as const,
      },
      // The route path. The global prefix turns it into `/api/auth`, the `basePath`
      // above - see AuthOptions.mountAt.
      '/auth',
    ),
  ],
  controllers: [ProfileController],
  providers: [AuthTables, Audit, AuthDemo],
  // `AuthTables` creates them on the app's own handle, so this module needs the
  // drizzle handle as well as the connection the factory above used.
  //
  // `Auth` comes back out because `OpenApiModule` wraps the root and can only
  // inject what the root exports - see bootstrap.ts.
  exports: [Audit, AuthDemo, Auth],
})
export class AccountsModule {}
