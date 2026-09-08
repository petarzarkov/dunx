import { Module } from '@dunx/core';
import { DatabaseModule } from '../database/database.module.js';
import { StatsModule } from '../stats/stats.module.js';
import { UpstreamModule } from '../upstream/upstream.module.js';
import { LandingMiddleware } from './landing.middleware.js';
import { RetryController } from './retry.controller.js';
import { VitalsController } from './vitals.controller.js';

/**
 * The page at `/` and the routes only that page calls. Here rather than in a
 * feature folder because `@dunx/create-app` vendors those wholesale, and a
 * `/api/demo` mount is right for a public demo and wrong for a scaffold.
 *
 * `RequestMetrics` is not imported: `@dunx/http` binds it globally.
 */
@Module({
  imports: [
    // `EventLoopLag`, exported rather than re-provided so there is one sampler.
    StatsModule,
    // `QueryMetrics`, which `DbModule.forRootAsync(..., { metrics: true })` fills.
    DatabaseModule,
    // `HttpService`, the outbound client whose retry policy the panel shows.
    UpstreamModule,
  ],
  controllers: [VitalsController, RetryController],
  providers: [LandingMiddleware],
  exports: [LandingMiddleware],
})
export class LandingModule {}
