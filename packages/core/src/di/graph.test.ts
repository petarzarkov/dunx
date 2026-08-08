import { describe, expect, it } from 'bun:test';
import { dependenciesOf, modulesOf, providersOf } from './graph.js';
import { Module } from './module.js';
import { provide } from './provider.js';
import { token, type Ctor } from './token.js';

/**
 * These readers moved down from `@dunx/mcp` when `@dunx/dashboard` became a second
 * consumer. The suite there covers them through the tool layer; this covers them
 * as core's own surface, and in particular the two things only core can be asked:
 * that nothing is constructed, and that the gateway predicate is genuinely
 * optional.
 */
class Repo {}
class Service {}
class Controller {}
class Socket {}

const CONFIG = token<string>('Config');

@Module({
  providers: [Repo, Service, Socket, provide(CONFIG, { useValue: 'x' })],
  controllers: [Controller],
  exports: [Service],
})
class FeatureModule {}

@Module({ imports: [FeatureModule], global: true, exports: [FeatureModule] })
class RootModule {}

describe('providersOf', () => {
  it('names what each registration binds and which module bound it', () => {
    const nodes = providersOf(RootModule);
    const byToken = new Map(nodes.map((node) => [node.token, node]));

    expect(byToken.get('Controller')).toMatchObject({
      role: 'controller',
      kind: 'class',
      module: 'FeatureModule',
    });
    expect(byToken.get('Config')).toMatchObject({
      role: 'provider',
      kind: 'value',
      dependencies: [],
    });
  });

  it('marks what the declaring module exports, which is the boundary', () => {
    const byToken = new Map(
      providersOf(RootModule).map((node) => [node.token, node]),
    );
    // "Why can't X see Y" is answerable from this field and nothing else.
    expect(byToken.get('Service')?.exported).toBe(true);
    expect(byToken.get('Repo')?.exported).toBe(false);
  });

  it('constructs nothing', () => {
    let built = 0;
    class Counted {
      constructor() {
        built += 1;
      }
    }
    @Module({ providers: [Counted] })
    class Counting {}

    expect(providersOf(Counting)).toHaveLength(1);
    expect(built).toBe(0);
  });
});

describe('the gateway predicate', () => {
  it('reports every class as an ordinary provider without one', () => {
    // Core cannot import `@dunx/http`, and an app with no web layer is the case
    // this default is right for.
    const socket = providersOf(RootModule).find(
      (node) => node.token === 'Socket',
    );
    expect(socket?.role).toBe('provider');
    expect(
      modulesOf(RootModule).find((m) => m.name === 'FeatureModule')?.gateways,
    ).toEqual([]);
  });

  it('splits gateways out when one is passed', () => {
    const isGateway = (ctor: Ctor<unknown>): boolean => ctor === Socket;

    const socket = providersOf(RootModule, { isGateway }).find(
      (node) => node.token === 'Socket',
    );
    expect(socket?.role).toBe('gateway');

    const feature = modulesOf(RootModule, { isGateway }).find(
      (m) => m.name === 'FeatureModule',
    );
    expect(feature?.gateways).toEqual(['Socket']);
    // And it is not double-counted as an ordinary provider.
    expect(feature?.providers).toEqual(['Repo', 'Service', 'Config']);
  });
});

describe('modulesOf', () => {
  it('reports imports, exports and whether the exports are global', () => {
    const root = modulesOf(RootModule).find((m) => m.name === 'RootModule');
    expect(root).toMatchObject({
      imports: ['FeatureModule'],
      // A module reference in `exports` re-exports that module's surface, so it
      // is named rather than being expanded into its tokens.
      exports: ['FeatureModule'],
      global: true,
    });
  });

  it('is in traversal order, so an import comes before what imported it', () => {
    expect(modulesOf(RootModule).map((m) => m.name)).toEqual([
      'FeatureModule',
      'RootModule',
    ]);
  });
});

describe('dependenciesOf', () => {
  it('reads the recorded thunk, unresolved entries included', () => {
    class Needs {}
    // Exactly what `@dunx/transform` appends after a class declaration: a thunk
    // under `Symbol.for('dunx.deps')`. Written by hand here because a package's
    // own suite runs with no compiler preload.
    Object.defineProperty(Needs, Symbol.for('dunx.deps'), {
      value: () => [Repo, { unresolved: 'clock', typeOnly: 'Clock' }],
    });

    expect(dependenciesOf(Needs)).toEqual([
      { token: 'Repo' },
      // `typeOnly` is carried because that case has a one-line fix.
      { unresolved: 'clock', typeOnly: 'Clock' },
    ]);
  });

  it('is empty for a class with nothing recorded', () => {
    class Bare {}
    expect(dependenciesOf(Bare)).toEqual([]);
  });
});
