import { describe, expect, it } from 'bun:test';
import { trace } from '@opentelemetry/api';
import { OtelTracer } from './index.js';

/**
 * `OtelModule` bound, no SDK registered: every span is the API's non-recording
 * one, which is the state an app ships in until it wires an exporter. The seam
 * still has to run and a throw still has to reach the caller, so this is the
 * path that must not be skipped when the span is.
 *
 * Its own file because `tracer.test.ts` registers a provider for the recording
 * path, and a global provider cannot be unregistered per test.
 */
trace.disable();

const REMOTE = {
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: '00f067aa0ba902b7',
  flags: '01',
};

describe('OtelTracer with no SDK registered', () => {
  const tracer = new OtelTracer();

  it('runs the callback and passes its value through', () => {
    expect(tracer.span('sync', {}, () => 42)).toBe(42);
  });

  it('reports no ids, so the seam keeps the ones it minted itself', () => {
    expect(tracer.span('ids', {}, (span) => span.ids())).toBeUndefined();
  });

  it('takes attributes and a recorded error without throwing', () => {
    expect(() =>
      tracer.span('attributes', {}, (span) => {
        span.setAttribute('db.system', 'sqlite');
        span.recordError(new Error('boom'));
      }),
    ).not.toThrow();
  });

  it('propagates a throw from the callback', () => {
    expect(() =>
      tracer.span('throws', {}, () => {
        throw new Error('from the callback');
      }),
    ).toThrow('from the callback');
  });

  it('propagates an async rejection', async () => {
    await expect(
      tracer.span('rejects', {}, async () => {
        await Bun.sleep(1);
        throw new Error('async boom');
      }),
    ).rejects.toThrow('async boom');
  });

  it('accepts a remote parent', () => {
    expect(
      tracer.span('remote', { parent: REMOTE }, (span) => span.ids()),
    ).toBe(undefined);
  });
});
