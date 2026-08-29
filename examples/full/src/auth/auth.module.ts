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

/** Named for the feature, so `AuthModule` still means `@dunx/auth`'s. */
@Module({
  imports: [
    DatabaseModule,
    // `forRootAsync`: the secret, base URL and connection all come from the
    // container, which a zero-argument factory cannot reach.
    AuthModule.forRootAsync(
      {
        // `DbConnection` is in DatabaseModule's scope, so it has to be named.
        // `AppConfigService` does not: ConfigModule is global.
        imports: [DatabaseModule],
        useFactory: (config: AppConfigService, connection: DbConnection) => ({
          secret: config.get('auth.secret'),
          baseURL: `http://localhost:${config.get('port')}`,
          // What better-auth matches a pathname against; the global prefix is
          // what makes the mounted `/auth` route answer here.
          basePath: '/api/auth',
          database: drizzleDatabase(connection),
          // The default `AuthModule` would apply anyway, named here to be
          // visible. better-auth's own default is JavaScript scrypt; this is
          // `Bun.password`'s native bcrypt.
          emailAndPassword: {
            enabled: true,
            minPasswordLength: 8,
            password: bunPassword,
          },
          // `admin` puts `role` on the user for `@Roles()`; `bearer` lets the
          // tour send a token instead of a cookie. `openAPI()` is what makes
          // `generateOpenAPISchema` exist for `betterAuthDocument` to merge, and
          // `disableDefaultReference` keeps it to one explorer.
          plugins: [
            admin(),
            bearer(),
            openAPI({ disableDefaultReference: true }),
          ],
        }),
        inject: [AppConfigService, DbConnection] as const,
      },
      '/auth',
    ),
  ],
  controllers: [ProfileController],
  providers: [AuthTables, Audit, AuthDemo],
  // `Auth` is exported because `OpenApiModule` wraps the root and can only
  // inject what the root exports. See main.ts.
  exports: [Audit, AuthDemo, Auth],
})
export class AccountsModule {}
