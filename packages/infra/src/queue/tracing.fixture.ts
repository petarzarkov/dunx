import { inject, RequestContext, type ModuleRef } from '@dunx/core';
import { OtelModule } from '@dunx/core/otel';
import { trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import { defaultRedisUrl } from '../redis/options.js';
import { JobHandler } from './decorators.js';
import { QueueModule } from './module.js';

/**
 * The module graph a forked child and the parent that forks it both boot. The
 * parent picks a fresh name per run and the child, which inherits the parent's
 * environment, reads the same one back.
 */
process.env['DUNX_OTEL_NS'] ??= `dunx-otel-${Bun.randomUUIDv7()}`;
export const PREFIX = process.env['DUNX_OTEL_NS'];
export const SANDBOXED = `${PREFIX}-sandboxed`;

/** What the handler saw, returned as the job's result so the parent can read it. */
export interface Witness {
  readonly pid: number;
  readonly fields: Record<string, unknown>;
  readonly span?: {
    readonly name: string;
    readonly traceId: string;
    readonly spanId: string;
    readonly parentSpanId: string | undefined;
  };
}

export class Sandboxed {
  readonly context = inject(RequestContext);

  @JobHandler({ queue: SANDBOXED, name: 'witness', background: true })
  witness(): Witness {
    const active = trace.getActiveSpan() as unknown as ReadableSpan | undefined;
    return {
      pid: process.pid,
      fields: this.context.getContext(),
      ...(active === undefined
        ? {}
        : {
            span: {
              name: active.name,
              traceId: active.spanContext().traceId,
              spanId: active.spanContext().spanId,
              parentSpanId: active.parentSpanContext?.spanId,
            },
          }),
    };
  }
}

class Root {}

export const sandboxedModule = (processor?: string): ModuleRef => ({
  module: Root,
  imports: [
    OtelModule,
    QueueModule.forRoot({
      url: defaultRedisUrl(),
      prefix: PREFIX,
      ...(processor === undefined ? {} : { processor }),
    }),
  ],
  providers: [Sandboxed],
});
