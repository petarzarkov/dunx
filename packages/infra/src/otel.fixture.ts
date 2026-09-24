import { context, trace } from '@opentelemetry/api';
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
}).register();

/** The finished spans in `traceId`, which keeps one test's spans from another's. */
export const spansOf = (traceId: string): readonly ReadableSpan[] =>
  exporter
    .getFinishedSpans()
    .filter((span) => span.spanContext().traceId === traceId);

/**
 * Runs `fn` under a fresh root span and returns the spans finished inside its
 * trace, the root excluded. A rejection from `fn` is swallowed, so a failure
 * test reads the spans the same way; assert on the error inside `fn`.
 */
export const traced = async (
  fn: () => unknown,
): Promise<readonly ReadableSpan[]> => {
  const root = trace.getTracer('test').startSpan('test');
  const active = trace.setSpan(context.active(), root);
  try {
    // Awaited inside, so a lazy thenable such as a `Bun.SQL` query starts
    // under the root rather than after the context is gone.
    await context.with(active, async () => {
      await fn();
    });
  } catch {
    // Read off the spans instead.
  } finally {
    root.end();
  }
  const { traceId, spanId } = root.spanContext();
  return spansOf(traceId).filter(
    (span) => span.spanContext().spanId !== spanId,
  );
};
