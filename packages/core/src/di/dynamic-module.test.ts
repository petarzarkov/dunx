import { describe, expect, it } from 'bun:test';
import { AppFactory } from './app.js';
import { collectModules, Module, type DynamicModule } from './module.js';
import { provide } from './provider.js';
import { token } from './token.js';

const rejectionMessage = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error))
    throw new Error('expected the promise to reject with an Error');
  return error.message;
};

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

/** The shape a configurable package exposes. */
class StoreModule {
  static forRoot(url: string): DynamicModule {
    return {
      module: StoreModule,
      providers: [provide(Options, { useValue: new Options(url) }), Client],
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
        return { module: BareModule, providers: [Client] };
      }
    }

    @Module({
      imports: [BareModule.forRoot(), StoreModule.forRoot('db://bare')],
    })
    class Root {}

    // Client is bound by BareModule and by StoreModule - the flat container says so.
    expect(await rejectionMessage(AppFactory.create(Root))).toContain(
      'Duplicate binding for Client',
    );
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

  it('reports two different configurations of one module instead of picking one', async () => {
    @Module({
      imports: [
        StoreModule.forRoot('db://one'),
        StoreModule.forRoot('db://two'),
      ],
    })
    class Root {}

    const message = await rejectionMessage(AppFactory.create(Root));
    expect(message).toContain('Duplicate binding for Options');
    expect(message).toContain('StoreModule');
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
