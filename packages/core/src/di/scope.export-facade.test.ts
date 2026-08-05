import { describe, expect, test } from 'bun:test';
import { AppFactory } from './app.js';
import { Module, type DynamicModule } from './module.js';
import { provide } from './provider.js';
import { token } from './token.js';

/**
 * Re-exporting a module reference is what makes a facade work, and the reference is
 * usually a `DynamicModule` from a static factory whose class carries **no**
 * `@Module` decorator - the documented shape, and the one every configured module in
 * `@dunx/infra` uses.
 *
 * That combination used to be rejected: the export classifier asked whether the
 * entry was a decorated module and an undecorated `{ module, providers }` failed the
 * test, so it was read as an injection token instead and boot died with
 * `Module "X" exports undefined`.
 */
const Handle = token<string>('Handle');

class Engine {
  static forRoot(value: string): DynamicModule {
    return {
      module: Engine,
      providers: [provide(Handle, { useValue: value })],
      exports: [Handle],
    };
  }
}

describe('exports of a module reference', () => {
  test('accepts a DynamicModule whose class has no @Module decorator', async () => {
    const engine = Engine.forRoot('open');

    @Module({ imports: [engine], exports: [engine] })
    class Infra {}

    @Module({ imports: [Infra] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Handle)).toBe('open');
    await app.shutdown();
  });
});
