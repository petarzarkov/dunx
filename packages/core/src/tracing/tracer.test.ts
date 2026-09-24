import { describe, expect, it } from 'bun:test';
import { AppFactory } from '../di/app.js';
import { Module } from '../di/module.js';
import { provide } from '../di/provider.js';
import { ActiveSpan, NoopTracer, Tracer } from './tracer.js';

describe('NoopTracer', () => {
  const tracer = new NoopTracer();

  it('returns what the callback returns, sync or promise', async () => {
    expect(tracer.span('sync', {}, () => 42)).toBe(42);
    expect(await tracer.span('async', {}, () => Promise.resolve('x'))).toBe(
      'x',
    );
  });

  it('hands the callback a span that records nothing and has no ids', () => {
    tracer.span('noop', { kind: 'server', attributes: { a: 1 } }, (span) => {
      expect(span).toBeInstanceOf(ActiveSpan);
      span.setAttribute('b', true);
      span.recordError(new Error('ignored'));
      expect(span.ids()).toBeUndefined();
    });
  });

  it('hands every call the same span, so the default allocates nothing', () => {
    const seen = new Set<ActiveSpan>();
    tracer.span('one', {}, (span) => seen.add(span));
    tracer.span('two', {}, (span) => seen.add(span));
    expect(seen.size).toBe(1);
  });

  it('lets a throw through untouched', () => {
    expect(() =>
      tracer.span('fails', {}, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
  });
});

describe('Tracer binding', () => {
  it('resolves to NoopTracer when no module binds it', async () => {
    @Module({})
    class Root {}
    const app = await AppFactory.create(Root);
    expect(app.get(Tracer)).toBeInstanceOf(NoopTracer);
    await app.shutdown();
  });

  it('yields to a module that binds its own', async () => {
    class Recording extends NoopTracer {}
    @Module({ providers: [provide(Tracer, { useClass: Recording })] })
    class Feature {}
    @Module({ imports: [Feature] })
    class Root {}
    const app = await AppFactory.create(Root);
    expect(app.get(Tracer)).toBeInstanceOf(Recording);
    expect(app.warnings).toEqual([]);
    await app.shutdown();
  });
});
