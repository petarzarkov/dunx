import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-node';

/**
 * One SDK for the whole run. `bun test` runs every file in one process and the
 * API's global provider can be registered once, so a second suite registering
 * its own would silently keep exporting to the first one's exporter.
 */
export const exporter = new InMemorySpanExporter();

new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
}).register({ propagator: new W3CTraceContextPropagator() });

/** The finished spans in `traceId`, which keeps one test's spans from another's. */
export const spansOf = (traceId: string): readonly ReadableSpan[] =>
  exporter
    .getFinishedSpans()
    .filter((span) => span.spanContext().traceId === traceId);
