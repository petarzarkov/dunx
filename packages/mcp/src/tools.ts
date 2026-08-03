import { collectModules, readControllers, type ModuleRef } from '@dunx/core';
import { discoverRoutes, PUBLIC, ROLES } from '@dunx/http';
import type { ToolDefinition } from './protocol.js';

/**
 * Everything here reads the app. Nothing boots it.
 *
 * `AppFactory.create` instantiates every provider and awaits every async factory
 * before it returns, so booting an app to answer "what routes exist" would open
 * database connections, start queue workers, bind sockets and run every `onInit` -
 * an agent asking a question about the code would be running the code. Route
 * discovery walks prototypes with `Object.create`, so no constructor runs.
 *
 * The cost of that choice: no runtime state. The value of a config field, or
 * whether the database is reachable, is not answerable here and should not be.
 */
interface Prototyped {
  readonly prototype: object;
}

const NO_ARGS = Object.freeze({ type: 'object', properties: {} });

/** Route discovery over a module graph, without constructing a controller. */
const routesOf = (root: ModuleRef) =>
  collectModules(root).flatMap((module) =>
    readControllers(module).flatMap((controller) => {
      const { prototype } = controller as unknown as Prototyped;
      return discoverRoutes(Object.create(prototype) as object).map(
        (route) => ({
          method: route.method,
          path: route.path,
          controller: route.controller,
          handler: route.handlerName,
          module: module.name,
          public: route.meta?.get(PUBLIC.id) === true,
          roles: route.meta?.get(ROLES.id) ?? null,
        }),
      );
    }),
  );

/**
 * The container graph, from the same two sources the container itself reads: each
 * module's registrations, and the dependency record `@dunx/transform` wrote.
 *
 * A parameter whose type was erased shows as `unresolved`, which is the thing most
 * worth being able to ask about - it is the boot error a reader hits first.
 */
const DEPS = Symbol.for('dunx.deps');

interface Marked {
  readonly [DEPS]?: () => readonly unknown[];
}

/**
 * `Symbol.for('dunx.deps')` directly, rather than core's `readDeps`, which is not
 * exported. That key is `Symbol.for` precisely so anything outside the package can
 * agree on it - it is the contract, and reading it here needs no widening of
 * core's public surface.
 *
 * The thunk is called rather than read: the record is deliberately lazy so a
 * dependency declared later in the file, or across a circular import, resolves.
 */
const dependenciesOf = (ctor: object): readonly Record<string, string>[] => {
  const thunk = (ctor as Marked)[DEPS];
  if (typeof thunk !== 'function') return [];

  return thunk().map((dep) =>
    typeof dep === 'object' && dep !== null && 'unresolved' in dep
      ? { unresolved: String((dep as { unresolved: unknown }).unresolved) }
      : { token: String((dep as { name?: string })?.name ?? dep) },
  );
};

const providersOf = (root: ModuleRef) =>
  collectModules(root).flatMap((module) =>
    readControllers(module).map((controller) => ({
      name: controller.name,
      module: module.name,
      dependencies: dependenciesOf(controller),
    })),
  );

export const toolsFor = (root: ModuleRef): readonly ToolDefinition[] => [
  {
    name: 'dunx_routes',
    description:
      'Every HTTP route the app declares, with its controller, handler, module, whether it is @Public() and any @Roles(). Read from the module graph without constructing anything - no database, no port, no side effects.',
    inputSchema: NO_ARGS,
    run: () => ({ routes: routesOf(root) }),
  },
  {
    name: 'dunx_providers',
    description:
      'Every controller in the module graph with the constructor dependencies recorded for it. A dependency whose type was erased appears as `unresolved`, which is the boot error to look for first.',
    inputSchema: NO_ARGS,
    run: () => ({ providers: providersOf(root) }),
  },
  {
    name: 'dunx_modules',
    description:
      'The module graph in traversal order, with the controller count each module contributes. The container is flat, so this is the order registrations are collected in.',
    inputSchema: NO_ARGS,
    run: () => ({
      modules: collectModules(root).map((module) => ({
        name: module.name,
        controllers: readControllers(module).map((c) => c.name),
      })),
    }),
  },
];
