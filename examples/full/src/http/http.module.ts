import { Module } from '@dunx/core';
import { HttpDemo } from './http.demo.js';
import { RequestLog, RequestLoggerMiddleware } from './request-log.js';

// `use()` resolves middleware from the container, and every class self-binds - so
// declaring them here is for the reader, not for the resolver.
@Module({
  providers: [RequestLog, RequestLoggerMiddleware, HttpDemo],
})
export class HttpModule {}
