import { Module, provide } from '@dunx/core';
import {
  CompressionModule,
  HttpOptionsProvider,
  WsRelayModule,
} from '@dunx/http';
import { AppConfigService } from '../config.js';
import { AppHttpOptions } from './http-options.js';
import { CompressionDemo } from './compression.demo.js';
import { TraceController } from './trace.controller.js';
import { TraceDemo } from './trace.demo.js';
import { HttpDemo } from './http.demo.js';
import { RequestTrail, RequestTrailMiddleware } from './request-trail.js';

// `use()` resolves middleware from the container, and every class self-binds - so
// declaring them here is for the reader, not for the resolver.
@Module({
  imports: [
    // Binds `Compression`; the **app** registers it, in `main.ts`, for the
    // same reason `StaticFiles` is registered there. Nothing is installed by
    // importing this, so an app that never calls `app.use(Compression)` has no
    // branch in the request path to skip.
    //
    // Defaults left alone apart from the threshold, which is here to be seen: a
    // body under it is sent as it is, because gzip's header and trailer alone are
    // 18 bytes and a short JSON response comes out larger.
    CompressionModule.forRoot({ threshold: 1024 }),
    /**
     * The relay as a provider, imported here because `AppHttpOptions` is what
     * consumes it. `main.ts` used to build `new RedisRelay(...)` and thread it
     * into `HttpFactory.create`, which was the last hand-built object in the
     * options. The container closes it at shutdown.
     *
     * `forPostgresAsync` here runs the same fan-out over Postgres, with a
     * factory returning `{ url }` for the database instead of these.
     */
    WsRelayModule.forRootAsync({
      useFactory: (config: AppConfigService) => {
        const { url } = config.get('redis');
        return {
          ...(url === undefined ? {} : { url }),
          connectionTimeout: 500,
        };
      },
      inject: [AppConfigService] as const,
    }),
  ],
  controllers: [TraceController],
  providers: [
    // The HTTP settings that read from config, resolved after the container
    // exists. `HttpFactory` promotes a default, so binding this replaces it.
    provide(HttpOptionsProvider, { useClass: AppHttpOptions }),
    RequestTrail,
    RequestTrailMiddleware,
    HttpDemo,
    CompressionDemo,
    TraceDemo,
  ],
  exports: [
    HttpOptionsProvider,
    RequestTrail,
    RequestTrailMiddleware,
    HttpDemo,
    CompressionDemo,
    TraceDemo,
  ],
})
export class HttpModule {}
