import { AuthModule } from '@dunx/auth';
import { drizzleDatabase } from '@dunx/auth/drizzle';
import { Module } from '@dunx/core';
import { DbConnection } from '@dunx/infra/db';
import { admin, bearer } from 'better-auth/plugins';
import { AppConfigService } from '../config.js';
import { AuthDemo } from './auth.demo.js';
import { AuthTables } from './auth.tables.js';
import { Audit } from './audit.service.js';
import { ProfileController } from './profile.controller.js';

/** Named for the feature rather than the package, so `AuthModule` still means `@dunx/auth`'s. */
@Module({
  imports: [
    // `forRootAsync` because the secret and the base URL come from the validated
    // config, and the database from the connection `DatabaseModule` already opened —
    // none of which a zero-argument factory could reach.
    AuthModule.forRootAsync(
      {
        useFactory: (config: AppConfigService, connection: DbConnection) => ({
          secret: config.get('auth').secret,
          baseURL: `http://localhost:${config.get('port')}`,
          // What better-auth matches an incoming pathname against. `app.setGlobalPrefix('api')`
          // is what makes the mounted `/auth` route answer here.
          basePath: '/api/auth',
          // The app's one drizzle handle. No second pool, no second SQLite file, and
          // the connection still closes exactly once, last.
          database: drizzleDatabase(connection),
          emailAndPassword: { enabled: true, minPasswordLength: 8 },
          // `admin` puts `role` on the user, which `@Roles()` then reads. `bearer`
          // lets a non-browser client send `Authorization: Bearer <token>` instead of
          // a cookie — which is what the tour does.
          plugins: [admin(), bearer()],
        }),
        inject: [AppConfigService, DbConnection] as const,
      },
      // The route path. The global prefix turns it into `/api/auth`, the `basePath`
      // above — see AuthOptions.mountAt.
      '/auth',
    ),
  ],
  controllers: [ProfileController],
  providers: [AuthTables, Audit, AuthDemo],
})
export class AccountsModule {}
