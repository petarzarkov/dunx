import { Module } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { CompressionModule } from './compression/module.js';
import { HealthModule } from './health/module.js';
import { StaticModule } from './static/module.js';
import { ThrottleModule } from './throttle/module.js';

/**
 * Every `forRootAsync` puts its caller's `imports` on the module it returns.
 *
 * A dynamic module is its own scope, so a factory injecting a provider needs the
 * module that exports it right there; importing it alongside does not reach the
 * factory. `AsyncModuleConfig` is what declares that field, and these four used to
 * restate it inline as `FactoryProvider<T, D> & { imports?: ... }`.
 *
 * Structural on purpose. The forwarding is one line per module and nothing else
 * asserted it, so deleting it would have gone unnoticed; the resolution itself is
 * covered where it can fail for a second reason, in `client/module.test.ts` and
 * `@dunx/openapi`'s `module.test.ts`.
 */
@Module({})
class Marker {}

const CONFIGURED = [
  [
    'CompressionModule',
    () =>
      CompressionModule.forRootAsync({
        imports: [Marker],
        useFactory: () => ({ threshold: 1 }),
      }),
  ],
  [
    'HealthModule',
    () =>
      HealthModule.forRootAsync({
        imports: [Marker],
        useFactory: () => ({ timeoutMs: 1 }),
      }),
  ],
  [
    'StaticModule',
    () =>
      StaticModule.forRootAsync({
        imports: [Marker],
        useFactory: () => ({ root: '.' }),
      }),
  ],
  [
    'ThrottleModule',
    () =>
      ThrottleModule.forRootAsync({
        imports: [Marker],
        useFactory: () => ({ limit: 1, windowSeconds: 1, prefix: 't' }),
      }),
  ],
] as const;

describe('forRootAsync forwards the imports it was given', () => {
  for (const [name, build] of CONFIGURED) {
    it(`${name} puts them on the module it returns`, () => {
      expect(build().imports).toContain(Marker);
    });
  }

  it('leaves imports off entirely when the caller passed none', () => {
    const module = CompressionModule.forRootAsync({
      useFactory: () => ({ threshold: 1 }),
    });

    expect(module.imports ?? []).toEqual([]);
  });
});
