import { describe, expect, it } from 'bun:test';
import { toolsFor } from './tools.js';
import { AppModule } from './app.fixture.js';
import type { ToolDefinition } from './protocol.js';

const tools = toolsFor(AppModule);

const tool = (name: string): ToolDefinition => {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};

const call = async (
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, never>> =>
  (await tool(name).run(args)) as Record<string, never>;

interface Route {
  method: string;
  path: string;
  controller: string;
  module: string;
  public: boolean;
  roles: string[] | null;
  guards: string[];
  status: number | null;
  responses: number[];
  validates: Record<string, string>;
}

const routes = async (args: Record<string, unknown> = {}): Promise<Route[]> =>
  ((await call('dunx_routes', args)) as unknown as { routes: Route[] }).routes;

interface Provider {
  token: string;
  kind: string;
  role: string;
  module: string;
  class?: string;
  dependencies: { token?: string; unresolved?: string; typeOnly?: string }[];
}

const providers = async (
  args: Record<string, unknown> = {},
): Promise<Provider[]> =>
  ((await call('dunx_providers', args)) as unknown as { providers: Provider[] })
    .providers;

describe('the tool set', () => {
  it('declares an object input schema for every tool', () => {
    expect(tools.map((t) => t.name)).toEqual([
      'dunx_overview',
      'dunx_routes',
      'dunx_providers',
      'dunx_gateways',
      'dunx_modules',
      'dunx_openapi',
    ]);
    for (const definition of tools) {
      expect(definition.inputSchema['type']).toBe('object');
      expect(definition.description.length).toBeGreaterThan(40);
    }
  });
});

describe('dunx_routes', () => {
  it('reads every route without constructing a controller', async () => {
    const all = await routes();
    expect(all.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'GET /health',
      'GET /notes',
      'POST /notes',
    ]);
  });

  it('carries the guard, the roles and the public marker', async () => {
    const [create] = await routes({ method: 'POST' });
    expect(create?.guards).toEqual(['AuthGuard']);
    expect(create?.roles).toEqual(['admin', 'editor']);
    expect(create?.public).toBe(false);

    const [list] = await routes({ method: 'GET', path: '/notes' });
    expect(list?.public).toBe(true);
    expect(list?.roles).toBeNull();
    expect(list?.guards).toEqual([]);
  });

  /**
   * The schemas the old version discarded entirely. Reporting *which* inputs are
   * validated needs no schema compiler; the JSON Schema itself is dunx_openapi.
   */
  it('reports the declared status, responses and validated inputs', async () => {
    const [create] = await routes({ method: 'POST' });
    expect(create?.status).toBe(201);
    expect(create?.responses.sort()).toEqual([201, 422]);
    expect(create?.validates).toEqual({ body: 'zod' });

    const [check] = await routes({ path: '/health' });
    expect(check?.status).toBeNull();
    expect(check?.validates).toEqual({});
  });

  it('names the module that contributed each route', async () => {
    const byPath = new Map(
      (await routes()).map((route) => [route.path, route.module]),
    );
    expect(byPath.get('/notes')).toBe('NotesModule');
    expect(byPath.get('/health')).toBe('AppModule');
  });

  it('filters by method, path, controller, module and publicOnly', async () => {
    expect(await routes({ method: 'get' })).toHaveLength(2);
    expect(await routes({ path: 'NOTES' })).toHaveLength(2);
    expect(await routes({ controller: 'health' })).toHaveLength(1);
    expect(await routes({ module: 'NotesModule' })).toHaveLength(2);
    expect(await routes({ publicOnly: true })).toHaveLength(1);
    expect(await routes({ method: 'DELETE' })).toHaveLength(0);
    // An empty string is not a filter; it is an unset argument.
    expect(await routes({ path: '' })).toHaveLength(3);
  });
});

describe('dunx_providers', () => {
  /** The whole point of the rewrite: services and bindings, not only controllers. */
  it('reports every registration, not just the controllers', async () => {
    const tokens = (await providers()).map((provider) => provider.token);
    expect(tokens).toContain('NotesController');
    expect(tokens).toContain('NotesService');
    expect(tokens).toContain('NotesRepository');
    expect(tokens).toContain('AuthGuard');
    expect(tokens).toContain('ChatGateway');
  });

  it('names a token() binding by its description, not [object Object]', async () => {
    const tokens = (await providers()).map((provider) => provider.token);
    expect(tokens).toContain('AppConfig');
    expect(tokens).toContain('Greeting');
    expect(tokens.join(' ')).not.toContain('[object Object]');
  });

  it('distinguishes class, value and factory bindings', async () => {
    const byToken = new Map(
      (await providers()).map((provider) => [provider.token, provider]),
    );
    expect(byToken.get('NotesService')?.kind).toBe('class');
    expect(byToken.get('AppConfig')?.kind).toBe('value');
    expect(byToken.get('Greeting')?.kind).toBe('factory');
    // A factory declares its dependencies; `inject()` is unusable after an await.
    expect(byToken.get('Greeting')?.dependencies).toEqual([
      { token: 'AppConfig' },
    ]);
    expect(byToken.get('AppConfig')?.dependencies).toEqual([]);
  });

  it('records the constructor dependencies the transform wrote', async () => {
    const [service] = await providers({ token: 'NotesService' });
    expect(service?.dependencies).toEqual([{ token: 'NotesRepository' }]);
  });

  it('tags a gateway by its role rather than as a plain provider', async () => {
    const [gateway] = await providers({ token: 'ChatGateway' });
    expect(gateway?.role).toBe('gateway');
    expect((await providers({ role: 'controller' })).length).toBe(2);
  });

  /** The boot error a reader hits first, so it has to be findable on its own. */
  it('surfaces an erased dependency, and the type-only case within it', async () => {
    const erased = await providers({ unresolvedOnly: true });
    expect(erased).toHaveLength(1);
    expect(erased[0]?.token).toBe('HealthController');
    expect(erased[0]?.dependencies[0]).toEqual({
      unresolved: 'private readonly config: AppConfig',
      typeOnly: 'AppConfig',
    });
  });

  it('filters by module', async () => {
    const names = (await providers({ module: 'AppModule' })).map(
      (p) => p.token,
    );
    expect(names).toContain('HealthController');
    expect(names).not.toContain('NotesService');
  });
});

describe('dunx_gateways', () => {
  interface Gateway {
    name: string;
    path: string;
    module: string;
    handlers: { kind: string; event: string | null; method: string }[];
  }
  const gateways = async (
    args: Record<string, unknown> = {},
  ): Promise<Gateway[]> =>
    ((await call('dunx_gateways', args)) as unknown as { gateways: Gateway[] })
      .gateways;

  it('finds a gateway declared in providers, with its normalised path', async () => {
    const all = await gateways();
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe('ChatGateway');
    expect(all[0]?.path).toBe('/chat');
    expect(all[0]?.module).toBe('NotesModule');
  });

  it('reports each handler kind and the event a message handler claims', async () => {
    const [chat] = await gateways();
    expect(chat?.handlers.map((handler) => handler.kind).sort()).toEqual([
      'message',
      'message',
      'open',
    ]);
    const events = chat?.handlers.map((handler) => handler.event) ?? [];
    expect(events).toContain('say');
    // The raw catch-all sees every unrouted frame and claims no event.
    expect(events).toContain(null);
  });

  it('filters by path and by event', async () => {
    expect(await gateways({ event: 'say' })).toHaveLength(1);
    expect(await gateways({ event: 'nope' })).toHaveLength(0);
    expect(await gateways({ path: 'chat' })).toHaveLength(1);
  });
});

describe('dunx_modules', () => {
  interface Mod {
    name: string;
    imports: string[];
    controllers: string[];
    providers: string[];
    gateways: string[];
  }
  const modules = async (args: Record<string, unknown> = {}): Promise<Mod[]> =>
    ((await call('dunx_modules', args)) as unknown as { modules: Mod[] })
      .modules;

  /** Imports before importers, which is the order registrations are collected in. */
  it('lists the graph in traversal order', async () => {
    expect((await modules()).map((module) => module.name)).toEqual([
      'NotesModule',
      'AppModule',
    ]);
  });

  it('separates controllers, providers and gateways', async () => {
    const [notes, app] = await modules();
    expect(notes?.controllers).toEqual(['NotesController']);
    expect(notes?.gateways).toEqual(['ChatGateway']);
    expect(notes?.providers).toContain('NotesService');
    expect(notes?.providers).toContain('AppConfig');
    expect(notes?.providers).not.toContain('ChatGateway');
    expect(app?.imports).toEqual(['NotesModule']);
  });

  it('filters by name', async () => {
    expect(await modules({ name: 'notes' })).toHaveLength(1);
  });
});

describe('dunx_overview', () => {
  it('counts the graph and lists what would fail at boot', async () => {
    const overview = (await call('dunx_overview')) as unknown as {
      modules: number;
      controllers: number;
      gateways: number;
      routes: number;
      publicRoutes: number;
      guardedRoutes: number;
      unresolvedDependencies: { provider: string; unresolved: string }[];
    };

    expect(overview.modules).toBe(2);
    expect(overview.controllers).toBe(2);
    expect(overview.gateways).toBe(1);
    expect(overview.routes).toBe(3);
    expect(overview.publicRoutes).toBe(1);
    expect(overview.guardedRoutes).toBe(1);
    expect(overview.unresolvedDependencies).toHaveLength(1);
    expect(overview.unresolvedDependencies[0]?.provider).toBe(
      'HealthController',
    );
  });
});

describe('dunx_openapi', () => {
  it('generates a document over the same routes', async () => {
    const document = (await call('dunx_openapi', {
      title: 'Fixture',
      version: '1.2.3',
    })) as unknown as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, Record<string, unknown>>;
    };

    expect(document.openapi).toBe('3.1.0');
    expect(document.info).toMatchObject({ title: 'Fixture', version: '1.2.3' });
    expect(Object.keys(document.paths).sort()).toEqual(['/health', '/notes']);
    expect(document.paths['/notes']).toHaveProperty('get');
    expect(document.paths['/notes']).toHaveProperty('post');
  });

  it('defaults the title to the root module name', async () => {
    const document = (await call('dunx_openapi')) as unknown as {
      info: { title: string; version: string };
    };
    expect(document.info.title).toBe('AppModule');
    expect(document.info.version).toBe('0.0.0');
  });
});
