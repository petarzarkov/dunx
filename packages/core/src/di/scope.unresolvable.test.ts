import { describe, expect, test } from 'bun:test';
import { AppFactory } from './app.js';
import { Module } from './module.js';
import { provide } from './provider.js';
import { token } from './token.js';

/**
 * `exports` reintroduces the most complained-about error in the Nest ecosystem, so
 * the message is the feature: it has to say which module declares the token,
 * whether the asking module imports it, whether it is exported, and the line to
 * add. Three shapes, and each says something different.
 *
 * Factories with an explicit `inject` rather than constructor parameters: a
 * package's own suite runs from `src` with no `@dunx/transform` preload.
 */
const SECRET = token<string>('Secret');
const OTHER = token<string>('Other');

describe('the message for a token nothing visible binds', () => {
  test('says nothing declares it, when nothing does', async () => {
    @Module({
      providers: [
        provide(OTHER, { useFactory: (s: string) => s, inject: [SECRET] }),
      ],
    })
    class Root {}

    expect(AppFactory.create(Root)).rejects.toThrow(
      /Nothing in the module graph declares it\. Bind it with provide\(\)/,
    );
  });

  test('names the declaring module and the missing export, when it is imported', async () => {
    @Module({ providers: [provide(SECRET, { useValue: 'kept in' })] })
    class Vault {}

    @Module({
      imports: [Vault],
      providers: [
        provide(OTHER, { useFactory: (s: string) => s, inject: [SECRET] }),
      ],
    })
    class Root {}

    const failure = AppFactory.create(Root);

    expect(failure).rejects.toThrow(/"Vault" declares it/);
    expect(failure).rejects.toThrow(
      /imports that module, but it does not export/,
    );
    expect(failure).rejects.toThrow(/Add .* to that module's exports/);
  });

  /**
   * The declaring module has to be somewhere in the graph for this branch: a module
   * nobody imports is never visited, so it reads as "nothing declares it" instead.
   * Root pulls Vault in; Consumer, which asks, does not.
   */
  test('names the missing import instead, when the asking module does not import it', async () => {
    @Module({
      providers: [provide(SECRET, { useValue: 'kept in' })],
      exports: [SECRET],
    })
    class Vault {}

    @Module({
      providers: [
        provide(OTHER, { useFactory: (s: string) => s, inject: [SECRET] }),
      ],
    })
    class Consumer {}

    @Module({ imports: [Vault, Consumer] })
    class Root {}

    const failure = AppFactory.create(Root);

    expect(failure).rejects.toThrow(/"Vault" declares it/);
    expect(failure).rejects.toThrow(/"Consumer" does not import it/);
    expect(failure).rejects.toThrow(/or give it global: true/);
  });

  test('names every module that declares it, not just the first', async () => {
    @Module({ providers: [provide(SECRET, { useValue: 'a' })] })
    class First {}

    @Module({ providers: [provide(SECRET, { useValue: 'b' })] })
    class Second {}

    @Module({
      imports: [First, Second],
      providers: [
        provide(OTHER, { useFactory: (s: string) => s, inject: [SECRET] }),
      ],
    })
    class Root {}

    const failure = AppFactory.create(Root);

    expect(failure).rejects.toThrow(/"First", "Second"/);
  });

  test('names the module that was asking', async () => {
    @Module({
      providers: [
        provide(OTHER, { useFactory: (s: string) => s, inject: [SECRET] }),
      ],
    })
    class Root {}

    expect(AppFactory.create(Root)).rejects.toThrow(/in module "Root"/);
  });
});
