import { Module, ResilienceModule } from '@dunx/core';
import {
  HttpModule as HttpClientModule,
  HttpRetryClassifier,
  HttpService,
} from '@dunx/http/client';
import { AppConfigService } from '../config.js';
import { FlakyController } from './flaky.controller.js';
import { HealthClient } from './health.client.js';
import { UpstreamDemo } from './upstream.demo.js';
import { UpstreamPolicy } from './upstream.policy.js';

/** `UpstreamPolicy`'s per-attempt budget, under `/upstream/slow`'s 300 ms. */
const POLICY_TIMEOUT_MS = 150;

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
        // The inbound trace, forwarded as `traceparent` so one trace spans
        // both services. On by default; stated here because it is the point of
        // this module.
        propagateTrace: true,
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
          /**
           * Bun-only, passed straight to `fetch`. A probe follows nothing: a
           * redirect from a health endpoint is a failure, not a hop to chase.
           *
           * `protocol: 'http2'` is the other option worth knowing about and is
           * **not** set here, because this app calls itself over cleartext HTTP
           * and Bun raises `HTTP2Unsupported` rather than falling back
           * (docs/bun-apis.md). Set it against an HTTPS upstream that offers h2.
           */
          maxRedirects: 0,
          headers: { 'user-agent': `${config.get('appName')}/health` },
        }),
        inject: [AppConfigService] as const,
      },
      HealthClient,
    ),
    /**
     * Retry, backoff and jitter around any operation rather than one request.
     * `@dunx/core` owns the loop; `HttpRetryClassifier` is what teaches it that a
     * 404 is an answer and a 503 is not, and `fallback` is what it answers with
     * once the attempts are spent. Its budget is under the client's, so a call
     * that outlives it is cancelled through the signal `run` hands each attempt.
     */
    ResilienceModule.forRootAsync(
      {
        useFactory: (config: AppConfigService) => ({
          timeoutMs: Math.min(
            POLICY_TIMEOUT_MS,
            config.get('upstream').timeoutMs,
          ),
          retry: {
            maxRetries: 2,
            retryDelayMs: 20,
            backoff: { jitterMs: 10, maxMs: 200 },
          },
          classifier: new HttpRetryClassifier(),
          fallback: () => ({ cached: true }),
        }),
        inject: [AppConfigService] as const,
      },
      UpstreamPolicy,
    ),
  ],
  controllers: [FlakyController],
  providers: [UpstreamDemo],
  /** `HttpService` is the default client `HttpClientModule.forRootAsync` bound
   * above. Exported so `LandingModule` can show the retry policy working; without
   * it the token stays inside this scope and the panel is a boot error. */
  exports: [UpstreamDemo, HealthClient, HttpService, UpstreamPolicy],
})
export class UpstreamModule {}
