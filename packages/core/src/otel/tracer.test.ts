import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { AppFactory } from '../di/app.js';
import { Module } from '../di/module.js';
import { Tracer } from '../tracing/tracer.js';
import { OtelModule, OtelTracer } from './index.js';

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  }).register();
});

afterEach(() => {
  exporter.reset();
});

const finished = (name: string) => {
  const span = exporter.getFinishedSpans().find((each) => each.name === name);
  if (span === undefined) throw new Error(`no finished span named ${name}`);
  return span;
};

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';

describe('OtelTracer', () => {
  const tracer = new OtelTracer();

  it('ends a sync span with its kind and attributes', () => {
    const value = tracer.span(
      'sync',
      { kind: 'client', attributes: { 'db.system': 'sqlite', rows: 3 } },
      (span) => {
        span.setAttribute('late', true);
        return 7;
      },
    );
    expect(value).toBe(7);
    const span = finished('sync');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes).toEqual({
      'db.system': 'sqlite',
      rows: 3,
      late: true,
    });
  });

  it('defaults to an internal span', () => {
    tracer.span('plain', {}, () => undefined);
    expect(finished('plain').kind).toBe(SpanKind.INTERNAL);
  });

  it('keeps a span open until its promise settles, and active across await', async () => {
    const value = await tracer.span('outer', {}, async () => {
      await Bun.sleep(1);
      expect(exporter.getFinishedSpans()).toHaveLength(0);
      trace.getTracer('user').startSpan('inner').end();
      return 'done';
    });
    expect(value).toBe('done');
    expect(finished('inner').parentSpanContext?.spanId).toBe(
      finished('outer').spanContext().spanId,
    );
  });

  it('records a throw as ERROR with an exception event, and rethrows it', () => {
    expect(() =>
      tracer.span('throws', {}, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    const span = finished('throws');
    expect(span.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'boom',
    });
    expect(span.events.map((event) => event.name)).toEqual(['exception']);
  });

  it('records a rejection the same way', async () => {
    const failing = tracer.span('rejects', {}, () =>
      Promise.reject(new Error('later')),
    );
    await expect(failing).rejects.toThrow('later');
    expect(finished('rejects').status.code).toBe(SpanStatusCode.ERROR);
  });

  it('marks a non-Error failure ERROR without an exception event', () => {
    tracer.span('status', {}, (span) => span.recordError('HTTP 503'));
    const span = finished('status');
    expect(span.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'HTTP 503',
    });
    expect(span.events).toEqual([]);
  });

  it('continues a remote parent, tracestate included', () => {
    tracer.span(
      'child',
      {
        kind: 'server',
        parent: {
          traceId: TRACE,
          spanId: PARENT,
          flags: '01',
          state: 'vendor=value',
        },
      },
      () => undefined,
    );
    const span = finished('child');
    expect(span.spanContext().traceId).toBe(TRACE);
    expect(span.parentSpanContext?.spanId).toBe(PARENT);
    expect(span.parentSpanContext?.isRemote).toBe(true);
    expect(span.spanContext().traceState?.get('vendor')).toBe('value');
  });

  it('reports the recording span ids', () => {
    const ids = tracer.span('ids', {}, (span) => span.ids());
    const context = finished('ids').spanContext();
    expect(ids).toEqual({
      traceId: context.traceId,
      spanId: context.spanId,
      flags: '01',
    });
  });

  it('reports no ids for a span the sampler dropped', () => {
    const ids = tracer.span(
      'unsampled',
      { parent: { traceId: TRACE, spanId: PARENT, flags: '00' } },
      (span) => span.ids(),
    );
    expect(ids).toBeUndefined();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe('OtelModule', () => {
  it('binds Tracer to OtelTracer for the whole graph', async () => {
    @Module({})
    class Feature {}
    @Module({ imports: [OtelModule, Feature] })
    class Root {}
    const app = await AppFactory.create(Root);
    expect(app.get(Tracer)).toBeInstanceOf(OtelTracer);
    expect(app.get(Tracer, Feature)).toBe(app.get(Tracer));
    expect(app.warnings).toEqual([]);
    await app.shutdown();
  });
});
