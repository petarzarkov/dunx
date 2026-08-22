import { RequestContext } from '@dunx/core';
import { Controller, Get, type Input, type RouteSchemas } from '@dunx/http';

/**
 * What the request's W3C trace looks like from inside a handler.
 *
 * `RequestContext` is bound by `@dunx/core` whatever else the app imports, and
 * `requestLogging: { trace: true }` is what puts the trace fields into it. Every
 * log line this request writes carries the same three values.
 */
@Controller('trace')
export class TraceController {
  constructor(private readonly context: RequestContext) {}

  @Get('/')
  current(input: Input<RouteSchemas>): {
    traceId: string | undefined;
    spanId: string | undefined;
    parentSpanId: string | undefined;
    inbound: string | null;
  } {
    const { traceId, spanId, parentSpanId } = this.context.getContext();
    return {
      traceId: traceId as string | undefined,
      spanId: spanId as string | undefined,
      parentSpanId: parentSpanId as string | undefined,
      inbound: input.req.headers.get('traceparent'),
    };
  }
}
