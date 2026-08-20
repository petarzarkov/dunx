import { describe, expect, it } from 'bun:test';
import { AppFactory } from './app.js';
import { Module, collectModules, type DynamicModule } from './module.js';
import { provide } from './provider.js';
import { buildScopes } from './scope.js';
import { token, type Token } from './token.js';

class Settings {
  constructor(readonly value: string) {}
}

class Reader {
  constructor(readonly settings: Settings) {}
}

/**
 * Bound with `inject` declared. Core's own test run has no `@dunx/transform`
 * preload, because one of its tests asserts what happens without one.
 */
const reader = () =>
  provide(Reader, {
    useFactory: (settings: Settings) => new Reader(settings),
    inject: [Settings] as const,
  });

/**
 * The shape the framework used to forbid: a `@Module` decorator carrying the static
 * half, and a `forRoot()` carrying the configured half.
 */
@Module({
  providers: [provide(Settings, { useValue: new Settings('default') })],
  exports: [Settings],
})
class Configurable {
  static forRoot(value: string): DynamicModule {
    return {
      module: Configurable,
      providers: [provide(Settings, { useValue: new Settings(value) })],
    };
  }
}

describe('@Module and forRoot() on one class', () => {
  it("lets the configured binding replace the decorator's default", async () => {
    @Module({ imports: [Configurable.forRoot('configured')] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Settings).value).toBe('configured');
    await app.shutdown();
  });

  it('keeps the decorator default when forRoot binds nothing for it', async () => {
    @Module({ imports: [{ module: Configurable }] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Settings).value).toBe('default');
    await app.shutdown();
  });

  it("keeps the decorator's exports, so the importer still sees them", async () => {
    @Module({
      imports: [Configurable.forRoot('x')],
      providers: [reader()],
      exports: [Reader],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Reader).settings.value).toBe('x');
    await app.shutdown();
  });

  /**
   * A plain concatenation registered an import once per place it was named, which is
   * two scopes and two of everything in them.
   */
  it('registers an import named in both places exactly once', () => {
    @Module({ providers: [reader()] })
    class Leaf {}

    @Module({ imports: [Leaf] })
    class Both {
      static forRoot(): DynamicModule {
        return { module: Both, imports: [Leaf] };
      }
    }

    const modules = collectModules({
      module: class Root {},
      imports: [Both.forRoot()],
    } as DynamicModule);
    const both = modules.find((entry) => entry.name === 'Both');
    expect(both?.options.imports).toEqual([Leaf]);
  });

  it('joins a controller list without duplicating a shared entry', () => {
    class Shared {}
    class Extra {}

    @Module({ controllers: [Shared] })
    class Mixed {}

    const [resolved] = collectModules({
      module: Mixed,
      controllers: [Shared, Extra],
    });
    expect(resolved?.options.controllers).toEqual([Shared, Extra]);
  });

  it('still rejects one token twice in the same providers list', () => {
    expect(() =>
      buildScopes({
        module: class Twice {},
        providers: [
          provide(Settings, { useValue: new Settings('a') }),
          provide(Settings, { useValue: new Settings('b') }),
        ],
      }),
    ).toThrow(/declared twice in the same providers list/);
  });
});

describe('re-exporting a configured import by its class', () => {
  it('resolves to the configuration this module imported', async () => {
    @Module({
      imports: [Configurable.forRoot('inner')],
      exports: [Configurable],
    })
    class Facade {}

    @Module({ imports: [Facade], providers: [reader()], exports: [Reader] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Reader).settings.value).toBe('inner');
    await app.shutdown();
  });

  it('leaves a token that happens to be a class alone', () => {
    const abstract = class Contract {};
    @Module({
      providers: [provide(abstract, { useValue: new abstract() })],
      exports: [abstract],
    })
    class Owns {}

    const [resolved] = collectModules(Owns);
    expect(resolved?.options.exports).toEqual([abstract]);
  });

  it('still fails when the class is neither imported nor declared', () => {
    class Absent {}
    @Module({ exports: [Absent] })
    class Root {}

    expect(() => buildScopes(Root)).toThrow(/does not/);
  });
});

describe('the same module configured twice', () => {
  it('warns, naming the class and the token both copies bind', () => {
    @Module({})
    class Twice {
      static forRoot(): DynamicModule {
        return {
          module: Twice,
          providers: [provide(Settings, { useValue: new Settings('x') })],
          exports: [Settings],
        };
      }
    }

    const { warnings } = buildScopes({
      module: class Root {},
      imports: [Twice.forRoot(), Twice.forRoot()],
    } as DynamicModule);

    expect(
      warnings.some((line) => line.includes('Twice is registered 2 times')),
    ).toBe(true);
    expect(warnings.some((line) => line.includes('Settings'))).toBe(true);
  });

  /**
   * Two configurations binding **different** tokens is the supported shape - a
   * default connection alongside a named one - so it has to stay silent.
   */
  it('stays silent when the two bind different tokens', () => {
    const first = token<string>('first');
    const second = token<string>('second');

    @Module({})
    class Named {
      static forRoot(as: Token<string>): DynamicModule {
        return {
          module: Named,
          providers: [provide(as, { useValue: 'v' })],
          exports: [as],
        };
      }
    }

    const { warnings } = buildScopes({
      module: class Root {},
      imports: [Named.forRoot(first), Named.forRoot(second)],
    } as DynamicModule);

    expect(
      warnings.some((line) => line.includes('is registered 2 times')),
    ).toBe(false);
  });
});
