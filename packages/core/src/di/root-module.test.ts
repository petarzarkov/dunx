import { describe, expect, it } from 'bun:test';
import { findRootModule, isModuleRef } from './module.js';
import { Module } from './module.js';

/**
 * Every tool that takes an entry path has to find the root module among a file's
 * exports, and none of them can guess a name. `bunx dunx-openapi` and
 * `bunx @dunx/mcp` both required `default` or `root`, while `@dunx/create-app`'s
 * template - and every example in this repo - ends `export class AppModule {}` and
 * nothing else, so the first thing anyone would try failed on a scaffolded app.
 */
@Module({})
class AppModule {}

@Module({})
class OtherModule {}

class Undecorated {}

/** A subclass does not inherit its base's bindings, so it is not a module either. */
class Subclass extends AppModule {}

describe('isModuleRef', () => {
  it('recognises a decorated class', () => {
    expect(isModuleRef(AppModule)).toBe(true);
  });

  it('recognises a configured module from a static factory', () => {
    expect(isModuleRef({ module: AppModule, providers: [] })).toBe(true);
  });

  it('rejects an undecorated class, a subclass, and non-modules', () => {
    expect(isModuleRef(Undecorated)).toBe(false);
    // hasOwn, matching how the container reads declared options.
    expect(isModuleRef(Subclass)).toBe(false);
    expect(isModuleRef({ module: Undecorated })).toBe(false);
    expect(isModuleRef(undefined)).toBe(false);
    expect(isModuleRef(null)).toBe(false);
    expect(isModuleRef(42)).toBe(false);
    expect(isModuleRef({})).toBe(false);
  });
});

describe('findRootModule', () => {
  /** The regression: a named export and nothing else. */
  it('finds the single decorated export whatever it is called', () => {
    expect(findRootModule({ AppModule })).toEqual({
      kind: 'found',
      root: AppModule,
    });
  });

  it('ignores exports that are not modules while finding the one that is', () => {
    expect(
      findRootModule({ AppModule, Undecorated, count: 1, helper: () => 1 }),
    ).toEqual({ kind: 'found', root: AppModule });
  });

  it('prefers root, then default, over the marker scan', () => {
    const byRoot = findRootModule({ root: AppModule, OtherModule });
    expect(byRoot).toEqual({ kind: 'found', root: AppModule });

    const byDefault = findRootModule({ default: AppModule, OtherModule });
    expect(byDefault).toEqual({ kind: 'found', root: AppModule });

    // root wins over default, which is the documented order.
    expect(findRootModule({ root: AppModule, default: OtherModule })).toEqual({
      kind: 'found',
      root: AppModule,
    });
  });

  it('reports a tie by name rather than picking one', () => {
    expect(findRootModule({ AppModule, OtherModule })).toEqual({
      kind: 'ambiguous',
      names: ['AppModule', 'OtherModule'],
    });
  });

  it('takes an explicit name, and reports one that names no module', () => {
    expect(findRootModule({ AppModule, OtherModule }, 'OtherModule')).toEqual({
      kind: 'found',
      root: OtherModule,
    });
    expect(findRootModule({ AppModule, Undecorated }, 'Undecorated')).toEqual({
      kind: 'none',
    });
    expect(findRootModule({ AppModule }, 'Missing')).toEqual({ kind: 'none' });
  });

  it('reports nothing found when the file declares no module', () => {
    expect(findRootModule({ Undecorated, value: 1 })).toEqual({ kind: 'none' });
    expect(findRootModule({})).toEqual({ kind: 'none' });
  });

  /** A configured module is what `Module.forRoot()` returns, and roots one too. */
  it('accepts a configured module as the root', () => {
    const configured = { module: AppModule, providers: [] };
    expect(findRootModule({ default: configured })).toEqual({
      kind: 'found',
      root: configured,
    });
  });
});
