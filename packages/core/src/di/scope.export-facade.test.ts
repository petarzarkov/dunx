import { describe, expect, test } from 'bun:test';
import { AppFactory } from './app.js';
import { Module, type DynamicModule, type ModuleRef } from './module.js';
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

  test('resolves through a chain of facades', async () => {
    const Deep = token<string>('Deep');

    @Module({
      providers: [provide(Deep, { useValue: 'deep' })],
      exports: [Deep],
    })
    class Bottom {}

    // Each level re-exports the one below it, so the set has to propagate all the
    // way up rather than reach only the first facade.
    let below: ModuleRef = Bottom;
    for (let level = 0; level < 5; level++) {
      const imports = [below];
      @Module({ imports, exports: imports as never })
      class Facade {}
      below = Facade;
    }

    @Module({ imports: [below] })
    class Root {}

    const app = await AppFactory.create(Root);
    try {
      expect(app.get(Deep)).toBe('deep');
    } finally {
      await app.shutdown();
    }
  });

  test('terminates when two modules re-export each other', async () => {
    const Left = token<string>('Left');
    const Right = token<string>('Right');
    const leftImports: unknown[] = [];
    const rightImports: unknown[] = [];
    const leftExports: unknown[] = [Left];
    const rightExports: unknown[] = [Right];

    @Module({
      imports: leftImports as never,
      providers: [provide(Left, { useValue: 'left' })],
      exports: leftExports as never,
    })
    class LeftModule {}

    @Module({
      imports: rightImports as never,
      providers: [provide(Right, { useValue: 'right' })],
      exports: rightExports as never,
    })
    class RightModule {}

    // Each imports and re-exports the other, so neither export set is computable
    // in one visit: this is the case the iteration exists for. Filled after both
    // classes exist, because a decorator cannot name a class declared below it.
    leftImports.push(RightModule);
    leftExports.push(RightModule);
    rightImports.push(LeftModule);
    rightExports.push(LeftModule);

    @Module({ imports: [LeftModule] })
    class Root {}

    const app = await AppFactory.create(Root);
    try {
      expect(app.get(Left)).toBe('left');
      expect(app.get(Right)).toBe('right');
    } finally {
      await app.shutdown();
    }
  });
});
