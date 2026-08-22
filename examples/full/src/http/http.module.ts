import { Module } from '@dunx/core';
import { HttpDemo } from './http.demo.js';
import { RequestTrail, RequestTrailMiddleware } from './request-trail.js';

// `use()` resolves middleware from the container, and every class self-binds - so
// declaring them here is for the reader, not for the resolver.
@Module({
  providers: [RequestTrail, RequestTrailMiddleware, HttpDemo],
  exports: [RequestTrail, RequestTrailMiddleware, HttpDemo],
})
export class HttpModule {}
