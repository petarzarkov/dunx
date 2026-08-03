import type { ModuleRef } from '@dunx/core';
import { modulesOf, providersOf } from './graph.js';
import { documentOf } from './openapi.js';
import type { ToolDefinition } from './protocol.js';
import { gatewaysOf, routesOf } from './routes.js';

/**
 * Everything here reads the app. Nothing boots it.
 *
 * `AppFactory.create` instantiates every provider and awaits every async factory
 * before it returns, so booting an app to answer "what routes exist" would open
 * database connections, start queue workers, bind sockets and run every `onInit` -
 * an agent asking a question about the code would be running the code, with side
 * effects, against whatever environment happened to be configured.
 *
 * The cost of that choice: no runtime state. The value of a config field, or
 * whether the database is reachable, is not answerable here and should not be. If
 * one is ever genuinely needed it belongs in a separately named tool whose
 * description says it boots the app, so the cost is visible at the call site
 * rather than hidden inside every answer.
 *
 * Every filter is optional and omitting it means everything, so a caller that
 * knows nothing still gets a useful answer on the first call. They exist because a
 * large app's full route table is a lot of tokens to hand a model that asked about
 * one path.
 */
const NO_ARGS = Object.freeze({ type: 'object', properties: {} });

const schema = (
  properties: Record<string, unknown>,
): Record<string, unknown> => ({
  type: 'object',
  properties,
  additionalProperties: false,
});

const str = (description: string): Record<string, unknown> => ({
  type: 'string',
  description,
});

const text = (
  args: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

const flag = (args: Record<string, unknown>, key: string): boolean =>
  args[key] === true;

/** Case-insensitive substring, which is what a caller guessing a name wants. */
const like = (haystack: string, needle: string | undefined): boolean =>
  needle === undefined || haystack.toLowerCase().includes(needle.toLowerCase());

const eq = (value: string, wanted: string | undefined): boolean =>
  wanted === undefined || value.toLowerCase() === wanted.toLowerCase();

export const toolsFor = (root: ModuleRef): readonly ToolDefinition[] => [
  {
    name: 'dunx_overview',
    description:
      'Counts of modules, controllers, routes, providers and gateways, plus every constructor dependency whose type was erased. The cheapest first call: it says how big the app is and whether it would boot, without returning the graph itself.',
    inputSchema: NO_ARGS,
    run: () => {
      const routes = routesOf(root);
      const providers = providersOf(root);
      const unresolved = providers.flatMap((provider) =>
        provider.dependencies
          .filter((dep) => 'unresolved' in dep)
          .map((dep) => ({
            provider: provider.token,
            module: provider.module,
            ...dep,
          })),
      );

      return {
        modules: modulesOf(root).length,
        controllers: providers.filter((p) => p.role === 'controller').length,
        gateways: gatewaysOf(root).length,
        providers: providers.filter((p) => p.role === 'provider').length,
        routes: routes.length,
        publicRoutes: routes.filter((route) => route.public).length,
        guardedRoutes: routes.filter(
          (route) => route.guards.length > 0 || route.roles !== null,
        ).length,
        // Listed rather than counted: each one is a boot error naming a
        // parameter, and it is the first thing worth acting on.
        unresolvedDependencies: unresolved,
      };
    },
  },
  {
    name: 'dunx_routes',
    description:
      'Every HTTP route the app declares, with its controller, handler, module, guards, @Public()/@Roles(), declared success status, and which inputs it validates. Read from the module graph without constructing anything - no database, no port, no side effects. For the request and response JSON Schemas, call dunx_openapi.',
    inputSchema: schema({
      method: str('Only this HTTP method, e.g. GET. Matched exactly.'),
      path: str('Only routes whose path contains this, e.g. /users.'),
      controller: str('Only routes on controllers whose name contains this.'),
      module: str(
        'Only routes contributed by modules whose name contains this.',
      ),
      publicOnly: {
        type: 'boolean',
        description:
          'Only routes marked @Public() - the unauthenticated surface.',
      },
    }),
    run: (args) => ({
      routes: routesOf(root).filter(
        (route) =>
          eq(route.method, text(args, 'method')) &&
          like(route.path, text(args, 'path')) &&
          like(route.controller, text(args, 'controller')) &&
          like(route.module, text(args, 'module')) &&
          (!flag(args, 'publicOnly') || route.public),
      ),
    }),
  },
  {
    name: 'dunx_providers',
    description:
      'Every registration in the container - controllers, gateways, services, useClass, useValue and useFactory bindings - with the module that bound it and the constructor dependencies recorded for it. A dependency whose type was erased appears as `unresolved`, which is the boot error to look for first.',
    inputSchema: schema({
      module: str('Only registrations from modules whose name contains this.'),
      token: str('Only registrations whose token contains this.'),
      role: {
        type: 'string',
        enum: ['controller', 'gateway', 'provider'],
        description: 'Only registrations of this role.',
      },
      unresolvedOnly: {
        type: 'boolean',
        description:
          'Only registrations with at least one erased dependency - the set that would fail at boot.',
      },
    }),
    run: (args) => ({
      providers: providersOf(root).filter(
        (provider) =>
          like(provider.module, text(args, 'module')) &&
          like(provider.token, text(args, 'token')) &&
          eq(provider.role, text(args, 'role')) &&
          (!flag(args, 'unresolvedOnly') ||
            provider.dependencies.some((dep) => 'unresolved' in dep)),
      ),
    }),
  },
  {
    name: 'dunx_gateways',
    description:
      'Every websocket gateway, with its path and the @OnMessage/@OnOpen/@OnClose handlers it declares, including the envelope event each message handler claims. Read from the class, never an instance.',
    inputSchema: schema({
      path: str('Only gateways whose path contains this.'),
      event: str('Only gateways declaring a message handler for this event.'),
    }),
    run: (args) => {
      const event = text(args, 'event');
      return {
        gateways: gatewaysOf(root).filter(
          (gateway) =>
            like(gateway.path, text(args, 'path')) &&
            (event === undefined ||
              gateway.handlers.some((handler) => handler.event === event)),
        ),
      };
    },
  },
  {
    name: 'dunx_modules',
    description:
      'The module graph in traversal order - imports before importers, which is the order registrations are collected in - with what each module contributes. The container is flat, so importing a module is traversal and not a visibility boundary.',
    inputSchema: schema({
      name: str('Only modules whose name contains this.'),
    }),
    run: (args) => ({
      modules: modulesOf(root).filter((module) =>
        like(module.name, text(args, 'name')),
      ),
    }),
  },
  {
    name: 'dunx_openapi',
    description:
      'The OpenAPI 3.1 document, with the request and response JSON Schemas derived from the routes own zod schemas. Requires @dunx/openapi and zod in the app; fails with what to install if absent. Use dunx_routes when the question is which routes exist rather than what they accept.',
    inputSchema: schema({
      title: str('Document title. Defaults to the root module name.'),
      version: str('Document version. Defaults to 0.0.0.'),
    }),
    run: (args) =>
      documentOf(root, {
        title:
          text(args, 'title') ??
          (typeof root === 'function' ? root.name : root.module.name),
        version: text(args, 'version') ?? '0.0.0',
      }),
  },
];
