import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
} from '@opentelemetry/sdk-trace-node';

/**
 * The SDK `OtelModule` reports to, registered here because dunx never
 * configures one. A preload rather than an import in `main.ts`, so the bullmq
 * fork that runs `background` jobs registers its own as well.
 *
 * Unset `OTEL_EXPORTER_OTLP_ENDPOINT` registers nothing: every span stays the
 * API's non-recording one and dunx keeps minting the trace ids it logs, which
 * is how `bun start` and the public demo run. The exporter reads the variable
 * itself, along with any other `OTEL_EXPORTER_OTLP_*` setting.
 */
if (Bun.env['OTEL_EXPORTER_OTLP_ENDPOINT']) {
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': Bun.env['OTEL_SERVICE_NAME'] ?? 'dunx-full',
    }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register();
  // Flushes the last batch once the shutdown hooks have drained the app.
  process.once('beforeExit', () => provider.shutdown());
}
