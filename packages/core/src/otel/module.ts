import { Module } from '../di/module.js';
import { provide } from '../di/provider.js';
import { Tracer } from '../tracing/tracer.js';
import { OtelTracer } from './tracer.js';

/**
 * Binds `Tracer` to {@link OtelTracer}, which every dunx seam then opens its
 * spans through. Register an SDK before `create`; this module never does.
 *
 * ```ts
 * new NodeTracerProvider({ spanProcessors: [...] }).register();
 *
 * @Module({ imports: [OtelModule, UsersModule] })
 * export class AppModule {}
 * ```
 *
 * A decorated class rather than a `forRoot()`, because it takes no options.
 * `Tracer` is promoted like `Logger`, so the binding reaches every scope.
 */
@Module({
  providers: [provide(Tracer, { useClass: OtelTracer })],
  exports: [Tracer],
})
export class OtelModule {}
