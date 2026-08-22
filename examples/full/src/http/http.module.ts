import { Module } from '@dunx/core';
import { CompressionModule } from '@dunx/http';
import { CompressionDemo } from './compression.demo.js';
import { TraceController } from './trace.controller.js';
import { TraceDemo } from './trace.demo.js';
import { HttpDemo } from './http.demo.js';
import { RequestTrail, RequestTrailMiddleware } from './request-trail.js';

// `use()` resolves middleware from the container, and every class self-binds - so
// declaring them here is for the reader, not for the resolver.
@Module({
  imports: [
    // Binds `Compression`; the **app** registers it, in `bootstrap.ts`, for the
    // same reason `StaticFiles` is registered there. Nothing is installed by
    // importing this, so an app that never calls `app.use(Compression)` has no
    // branch in the request path to skip.
    //
    // Defaults left alone apart from the threshold, which is here to be seen: a
    // body under it is sent as it is, because gzip's header and trailer alone are
    // 18 bytes and a short JSON response comes out larger.
    CompressionModule.forRoot({ threshold: 1024 }),
  ],
  controllers: [TraceController],
  providers: [
    RequestTrail,
    RequestTrailMiddleware,
    HttpDemo,
    CompressionDemo,
    TraceDemo,
  ],
  exports: [
    RequestTrail,
    RequestTrailMiddleware,
    HttpDemo,
    CompressionDemo,
    TraceDemo,
  ],
})
export class HttpModule {}
