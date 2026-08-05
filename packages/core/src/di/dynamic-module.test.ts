import { describe, expect, it } from 'bun:test';
import { AppFactory } from './app.js';
import { collectModules, Module, type DynamicModule } from './module.js';
import { provide } from './provider.js';
import { token } from './token.js';

class Options {
  constructor(readonly url: string) {}
}

class Client {
  readonly #options: Options;
  constructor(options: Options) {
    this.#options = options;
  }
  describe(): string {
    return `client:${this.#options.url}`;
  }
}
Object.defineProperty(Client, Symbol.for('dunx.deps'), {
  value: () => [Options],
});

/**
 * The shape a configurable package exposes - now including what it exposes.
 *
 * `Options` stays private: it is how the module was configured, not something a
 * consumer should reach for. `Client` is the public surface, which is exactly the
 * distinction `exports` exists to draw.
 */
class StoreModule {
  static forRoot(url: string): DynamicModule {
    return {
      module: StoreModule,
      providers: [provide(Options, { useValue: new Options(url) }), Client],
      exports: [Client],
    };
  }

  /**
   * No separate mechanism: eager resolution means an async factory is already
   * settled before any constructor runs, so this is `forRoot` with a factory.
   */
  static forRootAsync(load: () => Promise<string>): DynamicModule {
    return {
      module: StoreModule,
      providers: [
        provide(Options, {
          useFactory: async () => new Options(await load()),
        }),
        Client,
      ],
      exports: [Client],
    };
  }
}

describe('configured modules', () => {
  it('registers what the static factory returned', async () => {
    @Module({ imports: [StoreModule.forRoot('db://one')] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Client).describe()).toBe('client:db://one');
  });

  it('accepts a configured module as the root', async () => {
    const app = await AppFactory.create(StoreModule.forRoot('db://root'));
    expect(app.get(Client).describe()).toBe('client:db://root');
  });

  it('resolves an asynchronously configured module before any constructor runs', async () => {
    @Module({
      imports: [
        StoreModule.forRootAsync(async () => {
          await Bun.sleep(1);
          return 'db://async';
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Client).describe()).toBe('client:db://async');
  });

  it('merges the class decorator options with the configured ones', async () => {
    class Always {
      readonly always = true;
    }

    @Module({ providers: [Always] })
    class MixedModule {
      static forRoot(url: string): DynamicModule {
        return {
          module: MixedModule,
          providers: [provide(Options, { useValue: new Options(url) })],
          exports: [Always, Options],
        };
      }
    }

    @Module({ imports: [MixedModule.forRoot('db://merged')] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Always).always).toBe(true);
    expect(app.get(Options).url).toBe('db://merged');
  });

  it('does not require the module class to be decorated at all', async () => {
    class BareModule {
      static forRoot(): DynamicModule {
        return {
          module: BareModule,
          providers: [
            provide(Options, { useValue: new Options('db://bare') }),
            Client,
          ],
          exports: [Client],
        };
      }
    }

    @Module({ imports: [BareModule.forRoot()] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Client).describe()).toBe('client:db://bare');
  });

  /**
   * Two modules declaring `Client` used to be a duplicate-binding boot error. Under
   * module scoping it is two scopes, two bindings and two instances - the rebinding
   * the change exists to allow.
   *
   * The importer sees both exports, so the last import wins, and that is **warned**
   * rather than silent: Nest picks one without saying so and it costs people hours.
   * The warning is on the app rather than logged, because core has no logger.
   */
  it('warns when two imports export the same token, and takes the last', async () => {
    class BareModule {
      static forRoot(): DynamicModule {
        return {
          module: BareModule,
          providers: [
            provide(Options, { useValue: new Options('db://bare') }),
            Client,
          ],
          exports: [Client],
        };
      }
    }

    @Module({
      imports: [BareModule.forRoot(), StoreModule.forRoot('db://store')],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.warnings.join('\n')).toMatch(
      /imports Client from both "BareModule" and "StoreModule"/,
    );
    // Last import wins, deterministically, rather than by traversal accident.
    expect(app.get(Client).describe()).toBe('client:db://store');
  });

  it('traverses imports declared by a configured module', async () => {
    const Leaf = token<string>('Leaf');

    @Module({ providers: [provide(Leaf, { useValue: 'leaf' })] })
    class LeafModule {}

    class BranchModule {
      static forRoot(): DynamicModule {
        return { module: BranchModule, imports: [LeafModule] };
      }
    }

    @Module({ imports: [BranchModule.forRoot()] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Leaf)).toBe('leaf');
  });

  it('registers the same configured object once when imported twice', async () => {
    const configured = StoreModule.forRoot('db://shared');

    @Module({ imports: [configured] })
    class Left {}

    @Module({ imports: [configured] })
    class Right {}

    @Module({ imports: [Left, Right] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Client).describe()).toBe('client:db://shared');
  });

  /**
   * Two different configurations of one module used to be a duplicate-binding error,
   * because both landed in one flat container. They are now two scopes with the same
   * name, each holding its own `Options` - which is what makes configuring a package
   * twice for two different consumers possible at all.
   *
   * The importer still sees the ambiguity warned, because it imports both.
   */
  it('gives two configurations of one module a scope each', async () => {
    @Module({
      imports: [
        StoreModule.forRoot('db://one'),
        StoreModule.forRoot('db://two'),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.warnings.join('\n')).toMatch(
      /imports Client from both "StoreModule" and "StoreModule"/,
    );
    expect(app.get(Client).describe()).toBe('client:db://two');
  });

  it('still dedupes a bare class reached through a diamond', async () => {
    const Value = token<number>('Value');

    @Module({ providers: [provide(Value, { useValue: 1 })] })
    class SharedModule {}

    @Module({ imports: [SharedModule] })
    class Left {}

    @Module({ imports: [SharedModule] })
    class Right {}

    @Module({ imports: [Left, Right] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Value)).toBe(1);
  });

  it('orders a configured module before the module that imports it', () => {
    @Module({ imports: [StoreModule.forRoot('db://order')] })
    class Root {}

    expect(collectModules(Root).map((entry) => entry.name)).toEqual([
      'StoreModule',
      'Root',
    ]);
  });
});

describe('a DynamicModule naming its own decorated class', () => {
  const A = token<string>('A');
  const B = token<string>('B');
  const Cfg = token<string>('ConfigInput');

  /*
   * The options union rather than replace, which is what Nest does and what
   * `resolveRef` has always done deliberately. Pinned because the alternative
   * reading - that the dynamic options win - is the one people arrive with, and
   * a silent change either way would break apps invisibly.
   */
  it('unions the decorator options with the dynamic ones', async () => {
    @Module({ providers: [provide(A, { useValue: 'decorator-A' })] })
    class Root {
      static dyn(): DynamicModule {
        return {
          module: Root,
          providers: [provide(B, { useValue: 'dynamic-B' })],
        };
      }
    }

    const app = await AppFactory.create(Root.dyn());
    expect(app.get(A)).toBe('decorator-A');
    expect(app.get(B)).toBe('dynamic-B');
    await app.shutdown();
  });

  /**
   * The consequence of that union. It used to be a duplicate-binding error naming one
   * module twice, which sent people looking for a second module that did not exist.
   * Now the two configurations are two scopes, and the importer is warned that it is
   * seeing both - which names the real problem instead of a phantom collision.
   */
  it('warns when the union collects one module twice', async () => {
    class ConfigModule {
      static forRoot(value: string): DynamicModule {
        return {
          module: ConfigModule,
          providers: [provide(Cfg, { useValue: value })],
          exports: [Cfg],
        };
      }
    }

    @Module({ imports: [ConfigModule.forRoot('a')] })
    class Root {
      static dyn(): DynamicModule {
        return { module: Root, imports: [ConfigModule.forRoot('b')] };
      }
    }

    const app = await AppFactory.create(Root.dyn());
    expect(app.warnings.join('\n')).toMatch(
      /imports ConfigInput from both "ConfigModule" and "ConfigModule"/,
    );
    await app.shutdown();
  });

  /**
   * Two modules genuinely binding one token: legal, warned, and the last import wins.
   * The old behaviour was a boot error naming both, which is what module scoping
   * trades away in exchange for per-module rebinding.
   */
  it('warns and takes the last when two modules really do bind one token', async () => {
    @Module({ providers: [provide(A, { useValue: 'one' })], exports: [A] })
    class OneModule {}

    @Module({ providers: [provide(A, { useValue: 'two' })], exports: [A] })
    class TwoModule {}

    @Module({ imports: [OneModule, TwoModule] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.warnings.join('\n')).toMatch(
      /imports A from both "OneModule" and "TwoModule"/,
    );
    expect(app.get(A)).toBe('two');
    await app.shutdown();
  });
});
