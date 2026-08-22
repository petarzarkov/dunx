import { Module } from '@dunx/core';
import { HttpModule as HttpClientModule } from '@dunx/http/client';
import { AppConfigService } from '../config.js';
import { FlakyController } from './flaky.controller.js';
import { UpstreamDemo } from './upstream.demo.js';

/**
 * The outbound half of `@dunx/http`, from the `./client` subpath.
 *
 * Imported as `HttpClientModule`, because this app already has an `HttpModule` of
 * its own and `@dunx/http` exports `HttpFactory` for the inbound direction. The
 * subpath is what keeps the two unambiguous at an import site; the alias is what
 * keeps them unambiguous here.
 *
 * No `baseUrl`: this app calls itself, and its own url is not known until
 * `listen()` has run. A real upstream sets one and every call names a path.
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
          // Jitter comes from `crypto.getRandomValues`, not `Math.random`.
          backoff: { jitterMs: 10, maxMs: 200 },
        },
        // The inbound request id, forwarded to the upstream, so one trace spans
        // both services. Read from `RequestContext`, so it only carries when there
        // is a request in scope.
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
