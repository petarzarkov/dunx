import { describe, expect, it } from 'bun:test';
import { AppFactory } from './app.js';
import type { DepEntry } from './deps.js';
import { CircularDependencyError, AppError } from './errors.js';
import { inject } from './inject.js';
import { Module } from './module.js';
import { provide } from './provider.js';
import { token, type Ctor } from './token.js';

/**
 * Stands in for `@dunx/compiler`. Core is tested without the plugin on purpose:
 * the container's contract is the metadata, not the transform that writes it, and
 * `examples/full` covers the two working together.
 */
const withDeps = (
  ctor: Ctor<unknown>,
  deps: () => readonly DepEntry[],
): void => {
  Object.defineProperty(ctor, Symbol.for('dunx.deps'), { value: deps });
};

const rejectionMessage = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error))
    throw new Error('expected the promise to reject with an Error');
  return error.message;
};

describe('constructor injection', () => {
  it('resolves parameters from the recorded dependencies', async () => {
    class Config {
      readonly url = 'db://one';
    }
    class Repo {
      constructor(readonly config: Config) {}
    }
    withDeps(Repo, () => [Config]);

    @Module({ providers: [Repo, Config] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Repo).config.url).toBe('db://one');
  });

  it('returns the same singleton to every dependent', async () => {
    class Shared {}
    class Left {
      constructor(readonly shared: Shared) {}
    }
    class Right {
      constructor(readonly shared: Shared) {}
    }
    withDeps(Left, () => [Shared]);
    withDeps(Right, () => [Shared]);

    @Module({ providers: [Left, Right, Shared] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Left).shared).toBe(app.get(Right).shared);
  });

  it('names the parameter it cannot resolve', async () => {
    class Broken {
      constructor(readonly count: number) {}
    }
    withDeps(Broken, () => [{ unresolved: 'count: number' }]);

    @Module({ providers: [Broken] })
    class Root {}

    const message = await rejectionMessage(AppFactory.create(Root));
    expect(message).toContain('Broken cannot be constructed');
    expect(message).toContain('parameter 1 (count: number)');
    expect(message).toContain('nothing that exists at runtime');
  });

  it('reports the position of a later unresolved parameter', async () => {
    class Fine {}
    class Broken {
      constructor(
        readonly fine: Fine,
        readonly label: string,
      ) {}
    }
    withDeps(Broken, () => [Fine, { unresolved: 'label: string' }]);

    @Module({ providers: [Broken, Fine] })
    class Root {}

    expect(await rejectionMessage(AppFactory.create(Root))).toContain(
      'parameter 2 (label: string)',
    );
  });

  it('resolves an async factory reached through a constructor parameter', async () => {
    abstract class Database {
      abstract query(): string;
    }
    class Repo {
      constructor(readonly db: Database) {}
    }
    withDeps(Repo, () => [Database]);

    @Module({
      providers: [
        Repo,
        provide(Database, {
          useFactory: async () => {
            await Bun.sleep(1);
            return { query: () => 'rows' };
          },
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Repo).db.query()).toBe('rows');
  });

  it('detects a cycle that runs through constructor parameters', async () => {
    class Left {
      constructor(readonly right: unknown) {}
    }
    class Right {
      constructor(readonly left: unknown) {}
    }
    withDeps(Left, () => [Right]);
    withDeps(Right, () => [Left]);

    @Module({ providers: [Left, Right] })
    class Root {}

    const error = await AppFactory.create(Root).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(CircularDependencyError);
    expect((error as Error).message).toContain('Left -> Right -> Left');
  });

  it('mixes constructor parameters with inject() in field initializers', async () => {
    class Config {
      readonly name = 'mixed';
    }
    class Logger {
      readonly lines: string[] = [];
    }
    class Service {
      readonly #logger = inject(Logger);
      constructor(readonly config: Config) {}

      run(): void {
        this.#logger.lines.push(this.config.name);
      }
    }
    withDeps(Service, () => [Config]);

    @Module({ providers: [Service, Config, Logger] })
    class Root {}

    const app = await AppFactory.create(Root);
    app.get(Service).run();
    expect(app.get(Logger).lines).toEqual(['mixed']);
  });

  it('constructs a class with no recorded dependencies with no arguments', async () => {
    class Plain {
      readonly ready = true;
    }

    @Module({ providers: [Plain] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Plain).ready).toBe(true);
  });
});

describe('missing transform', () => {
  it('reports the setup that was skipped instead of passing undefined', async () => {
    // No withDeps() call: exactly the state of a class the plugin never saw.
    class Untransformed {
      constructor(readonly repo: unknown) {}
    }

    @Module({ providers: [Untransformed] })
    class Root {}

    const message = await rejectionMessage(AppFactory.create(Root));
    expect(message).toContain('Untransformed declares 1 constructor parameter');
    expect(message).toContain('@dunx/compiler did not transform');
    expect(message).toContain('preload = ["@dunx/compiler/preload"]');
  });

  it('does not fire for a constructor whose parameters all have defaults', async () => {
    // `length` counts parameters before the first default, so this is 0 and the
    // class is genuinely constructible with no arguments.
    class Defaulted {
      constructor(readonly label = 'fallback') {}
    }

    @Module({ providers: [Defaulted] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Defaulted).label).toBe('fallback');
  });

  it('does not fire for a class the container never constructs', async () => {
    class NeverConstructed {
      constructor(readonly a: unknown) {}
    }
    const ready = new NeverConstructed('supplied by hand');

    @Module({ providers: [provide(NeverConstructed, { useValue: ready })] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(NeverConstructed).a).toBe('supplied by hand');
  });
});

describe('inheritance', () => {
  it('inherits the base class dependencies when the subclass declares no constructor', async () => {
    class Config {
      readonly url = 'db://base';
    }
    class Base {
      constructor(readonly config: Config) {}
    }
    withDeps(Base, () => [Config]);
    class Child extends Base {}

    @Module({ providers: [Child, Config] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Child).config.url).toBe('db://base');
  });

  it('lets a subclass own record shadow the base one', async () => {
    class Left {
      readonly which = 'left';
    }
    class Right {
      readonly which = 'right';
    }
    class Base {
      constructor(readonly dep: Left | Right) {}
    }
    withDeps(Base, () => [Left]);
    class Child extends Base {
      constructor(dep: Right) {
        super(dep);
      }
    }
    withDeps(Child, () => [Right]);

    @Module({ providers: [Child, Left, Right] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Child).dep.which).toBe('right');
  });
});

describe('deferred resolution', () => {
  it('does not evaluate the dependency list at class-definition time', async () => {
    // The thunk closes over a binding declared after the class, which is the
    // temporal-dead-zone case that would crash an eagerly evaluated array.
    class Late {
      constructor(readonly config: unknown) {}
    }
    withDeps(Late, () => [DeclaredLater]);

    class DeclaredLater {
      readonly ok = true;
    }

    @Module({ providers: [Late, DeclaredLater] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect((app.get(Late).config as DeclaredLater).ok).toBe(true);
  });

  it('surfaces an unbound constructor dependency as a provider error', async () => {
    // A token() has no constructor, so it cannot self-bind. An unbound abstract
    // class would be constructed instead — `abstract` is erased at runtime, which
    // is the erasure cost recorded in docs/ARCHITECTURE.md.
    const Missing = token<{ value(): string }>('Missing');
    class Needs {
      constructor(readonly missing: unknown) {}
    }
    withDeps(Needs, () => [Missing]);

    @Module({ providers: [Needs] })
    class Root {}

    const error = await AppFactory.create(Root).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as Error).message).toContain('No provider for Missing');
  });
});
