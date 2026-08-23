import { Module } from '@dunx/core';
import { HttpModule as HttpClientModule } from '@dunx/http/client';
import { AppConfigService } from '../config.js';
import { FlakyController } from './flaky.controller.js';
import { UpstreamDemo } from './upstream.demo.js';

/**
 * The outbound half of `@dunx/http`, from the `./client` subpath, aliased because
 * this app has an `HttpModule` of its own. No `baseUrl`: this app calls itself,
 * and its url is not known until `listen()` has run.
 */
@Module({
  imports: [
    HttpClientModule.forRootAsync({
      useFactory: (config: AppConfigService) => ({
        ...config.get('upstream'),
        headers: { 'user-agent': `${config.get('appName')}/outbound` },
        retry: {
          maxRetries: 3,
          retryDelayMs: 20,
          backoff: { jitterMs: 10, maxMs: 200 },
        },
        // The inbound request id, forwarded so one trace spans both services.
        propagateRequestId: true,
      }),
      inject: [AppConfigService] as const,
    }),
  ],
  controllers: [FlakyController],
  providers: [UpstreamDemo],
  exports: [UpstreamDemo],
})
export class UpstreamModule {}
