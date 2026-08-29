import { Module } from '@dunx/core';
import { HttpModule as HttpClientModule } from '@dunx/http/client';
import { AppConfigService } from '../config.js';
import { FlakyController } from './flaky.controller.js';
import { HealthClient } from './health.client.js';
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
    /**
     * A second client, bound to a subclass rather than a name, so `HealthClient`
     * is an ordinary constructor parameter. It does not claim `HttpService`, so
     * the default above is untouched.
     */
    HttpClientModule.forRootAsync(
      {
        useFactory: (config: AppConfigService) => ({
          ...config.get('upstream'),
          // A readiness probe waits far less than a business call.
          timeoutMs: 1_000,
          headers: { 'user-agent': `${config.get('appName')}/health` },
        }),
        inject: [AppConfigService] as const,
      },
      HealthClient,
    ),
  ],
  controllers: [FlakyController],
  providers: [UpstreamDemo],
  exports: [UpstreamDemo, HealthClient],
})
export class UpstreamModule {}
