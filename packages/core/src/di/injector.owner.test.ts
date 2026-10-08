import { describe, expect, it } from 'bun:test';
import { AppFactory } from './app.js';
import { inject } from './inject.js';
import { Injector } from './injector.js';
import { Module } from './module.js';
import { provide } from './provider.js';
import { buildScopes } from './scope.js';
import { token } from './token.js';

const PrivateConfig = token<string>('PrivateConfig');

class SharedService {
  readonly config = inject(PrivateConfig);
}

class Consumer {
  readonly shared = inject(SharedService);
}

@Module({ providers: [Consumer] })
class FeatureModule {}

@Module({
  global: true,
  providers: [
    SharedService,
    provide(PrivateConfig, { useValue: 'owner-config' }),
  ],
  exports: [SharedService],
})
class SharedModule {}

describe('provider construction scope', () => {
  for (const imports of [
    [FeatureModule, SharedModule],
    [SharedModule, FeatureModule],
  ]) {
    it(`resolves global providers with private dependencies: ${imports.map((m) => m.name).join(', ')}`, async () => {
      @Module({ imports })
      class Root {}

      const app = await AppFactory.create(Root);
      try {
        expect(app.get(Consumer).shared.config).toBe('owner-config');
        expect(app.get(Consumer).shared).toBe(app.get(SharedService));
      } finally {
        await app.shutdown();
      }
    });
  }

  it('does not use a consumer override for an imported provider', () => {
    @Module({
      providers: [SharedService, provide(PrivateConfig, { useValue: 'owner' })],
      exports: [SharedService],
    })
    class Owner {}
    @Module({
      imports: [Owner],
      providers: [provide(PrivateConfig, { useValue: 'consumer' })],
    })
    class Client {}

    const graph = buildScopes(Client);
    const injector = new Injector(graph);
    expect(injector.get(SharedService).config).toBe('owner');
    expect(injector.get(PrivateConfig)).toBe('consumer');
    expect(injector.get(SharedService, graph.scopes.get(Owner))).toBe(
      injector.get(SharedService),
    );
  });

  it('resolves constructor metadata through a re-export in the declaring scope', () => {
    class Service {
      constructor(readonly config: string) {}
    }
    Object.defineProperty(Service, Symbol.for('dunx.deps'), {
      value: () => [PrivateConfig],
    });
    @Module({
      providers: [Service, provide(PrivateConfig, { useValue: 'owner' })],
      exports: [Service],
    })
    class Owner {}
    @Module({ imports: [Owner], exports: [Owner] })
    class Facade {}
    @Module({ imports: [Facade] })
    class Client {}

    const injector = new Injector(buildScopes(Client));
    expect(injector.get(Service).config).toBe('owner');
    expect(() => injector.get(PrivateConfig)).toThrow('Cannot resolve');
  });

  it('keeps separate owners for the same provider token', () => {
    @Module({
      providers: [SharedService, provide(PrivateConfig, { useValue: 'first' })],
      exports: [SharedService],
    })
    class First {}
    @Module({
      providers: [
        SharedService,
        provide(PrivateConfig, { useValue: 'second' }),
      ],
      exports: [SharedService],
    })
    class Second {}
    @Module({ imports: [First] })
    class FirstClient {}
    @Module({ imports: [Second] })
    class SecondClient {}
    @Module({ imports: [FirstClient, SecondClient] })
    class Root {}

    const graph = buildScopes(Root);
    const injector = new Injector(graph);
    const first = injector.get(SharedService, graph.scopes.get(FirstClient));
    const second = injector.get(SharedService, graph.scopes.get(SecondClient));
    expect(first.config).toBe('first');
    expect(second.config).toBe('second');
    expect(first).not.toBe(second);
  });

  for (const asyncFactory of [false, true]) {
    it(`resolves ${asyncFactory ? 'async' : 'sync'} factory dependencies in the declaring scope`, async () => {
      const Service = token<{ config: string }>('FactoryService');
      @Module({
        providers: [
          provide(PrivateConfig, { useValue: 'owner' }),
          provide(Service, {
            inject: [PrivateConfig],
            useFactory: (config: string) =>
              asyncFactory ? Promise.resolve({ config }) : { config },
          }),
        ],
        exports: [Service],
      })
      class Owner {}
      @Module({ imports: [Owner] })
      class Client {}

      const graph = buildScopes(Client);
      const injector = new Injector(graph);
      const service = await injector.resolve(Service);
      expect(service.config).toBe('owner');
      expect(injector.get(Service, graph.scopes.get(Owner))).toBe(service);
    });
  }
});
