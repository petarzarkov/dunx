import { Module } from '@dunx/core';
import { SignedCookiesModule } from '@dunx/http';
import { AppConfigService } from '../config.js';
import { PreferencesController } from './preferences.controller.js';
import { PreferencesDemo } from './preferences.demo.js';

/**
 * `SignedCookiesModule` is global, so the secrets bound here sign for any
 * controller in the app. `COOKIE_SECRETS` is a comma-separated list: the first
 * signs, and an older one kept after it still verifies while its cookies live.
 */
@Module({
  imports: [
    SignedCookiesModule.forRootAsync({
      useFactory: (config: AppConfigService) => ({
        secrets: config.get('cookies').secrets,
      }),
      inject: [AppConfigService] as const,
    }),
  ],
  controllers: [PreferencesController],
  providers: [PreferencesDemo],
  exports: [PreferencesDemo],
})
export class PreferencesModule {}
