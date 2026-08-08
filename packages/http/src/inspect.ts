import {
  collectModules,
  dependenciesOf,
  readControllers,
  type Ctor,
  type Dependency,
  type ModuleRef,
  type ProviderEntry,
} from '@dunx/core';
import { discoverRoutes, type DiscoveredRoute } from './route/discover.js';
import { HIDDEN, PUBLIC, ROLES } from './route/metadata.js';
import type { RouteSchemas, StandardSchemaV1 } from './route/schema.js';
import { discoverGateway } from './ws/discover.js';
import { isGateway } from './ws/marker.js';

/**
 * Routes and gateways read off the module graph, constructing nothing.
 *
 * The traversal itself is `@dunx/core`'s - `collectModules`, `readControllers`,
 * `dependenciesOf`. What is here is the half that needs this package's own
 * metadata: route markers, guards, `@Roles`/`@Public`, and the gateway marker.
 * Two consumers read it, `@dunx/mcp` from outside a process that never boots and
 * `@dunx/dashboard` from inside one that already has.
 *
 * Routes read off the module graph. `discoverRoutes` walks a prototype chain, and
 * `Object.create(Controller.prototype)` is that chain with nothing behind it:
 * `instance.constructor` still resolves to the class and every method is still
 * reachable, so no constructor - or dependency of one - has to exist.
 */
interface Prototyped {
  readonly prototype: object;
}

export interface RouteInputs {
  readonly body?: string;
  readonly query?: string;
  readonly params?: string;
}

export interface RouteNode {
  readonly method: string;
  readonly path: string;
  readonly controller: string;
  readonly handler: string;
  readonly module: string;
  readonly public: boolean;
  readonly roles: readonly string[] | null;
  /** Class-level `@UseGuards` first, then method-level, which is resolution order. */
  readonly guards: readonly string[];
  /** `@ApiHidden()`, so a caller can tell "not documented" from "not there". */
  readonly hidden: boolean;
  /**
   * Which inputs the route validates, and by which Standard Schema vendor. The
   * schemas themselves are not here: turning one into JSON Schema is zod-specific
   * work that `@dunx/openapi` already does, and `dunx_openapi` is where it lives.
   * What this answers is "does this route parse a body at all", which is the
   * question that does not need a schema compiler.
   */
  readonly validates: RouteInputs;
  /** The success status the decorator declared, or null for the default. */
  readonly status: number | null;
  /** Status codes the route documents a response schema for. */
  readonly responses: readonly number[];
}

const vendorOf = (schema: StandardSchemaV1 | undefined): string | undefined =>
  schema?.['~standard']?.vendor;

const validatesIn = (options: RouteSchemas | undefined): RouteInputs => {
  const body = vendorOf(options?.body);
  const query = vendorOf(options?.query);
  const params = vendorOf(options?.params);
  return {
    ...(body === undefined ? {} : { body }),
    ...(query === undefined ? {} : { query }),
    ...(params === undefined ? {} : { params }),
  };
};

/**
 * `@Roles()` stores whatever it was given. Normalised to an array of strings here
 * so the wire shape is one type rather than "string or array, sometimes".
 */
const rolesIn = (route: DiscoveredRoute): readonly string[] | null => {
  const roles = route.meta?.get(ROLES.id);
  if (roles === undefined || roles === null) return null;
  return (Array.isArray(roles) ? roles : [roles]).map(String);
};

const nodeFor = (route: DiscoveredRoute, module: string): RouteNode => ({
  method: route.method,
  path: route.path,
  controller: route.controller,
  handler: route.handlerName,
  module,
  public: route.meta?.get(PUBLIC.id) === true,
  roles: rolesIn(route),
  guards: (route.guards ?? []).map((guard) => guard.name),
  hidden: route.meta?.get(HIDDEN.id) === true,
  validates: validatesIn(route.options),
  status: route.options?.status ?? null,
  responses: Object.keys(route.options?.response ?? {}).map(Number),
});

export const routesOf = (root: ModuleRef): readonly RouteNode[] =>
  collectModules(root).flatMap((module) =>
    readControllers(module).flatMap((controller) => {
      const { prototype } = controller as unknown as Prototyped;
      return discoverRoutes(Object.create(prototype) as object).map((route) =>
        nodeFor(route, module.name),
      );
    }),
  );

/**
 * Gateways are declared in `@Module({ providers })` like any other injectable and
 * found by their marker, so they are read the same way routes are: the class's
 * prototype, never an instance.
 *
 * `discoverGateway` does all of it - the path, the marked methods, the event each
 * message handler claims - and `Object.create(Gateway.prototype)` satisfies its
 * one argument, exactly as it satisfies `discoverRoutes`. Its sibling
 * `discoverGateways` is the one that is unusable here: it takes a `resolve`
 * callback and constructs every gateway, which is the boot this package exists to
 * avoid. Only the bound `invoke` is dropped, being a function.
 */
export interface GatewayHandler {
  readonly kind: string;
  /** The envelope event a message handler claims; null is the raw catch-all. */
  readonly event: string | null;
  readonly method: string;
}

export interface GatewayNode {
  readonly name: string;
  readonly path: string;
  readonly module: string;
  readonly dependencies: readonly Dependency[];
  readonly handlers: readonly GatewayHandler[];
}

const gatewayFor = (ctor: Ctor<unknown>, module: string): GatewayNode => {
  const { name, path, handlers } = discoverGateway(
    Object.create((ctor as unknown as Prototyped).prototype) as object,
  );

  return {
    name,
    path,
    module,
    dependencies: dependenciesOf(ctor),
    handlers: handlers.map((handler) => ({
      kind: handler.kind,
      event: handler.event ?? null,
      method: handler.method,
    })),
  };
};

/** The class a `providers` entry would construct, or nothing for value/factory. */
const classOf = (entry: ProviderEntry): Ctor<unknown> | undefined => {
  if (typeof entry === 'function') return entry;
  return entry.provider.kind === 'class' ? entry.provider.ctor : undefined;
};

export const gatewaysOf = (root: ModuleRef): readonly GatewayNode[] =>
  collectModules(root).flatMap((module) =>
    (module.options.providers ?? [])
      .map(classOf)
      .filter((ctor): ctor is Ctor<unknown> => ctor !== undefined)
      .filter(isGateway)
      .map((ctor) => gatewayFor(ctor, module.name)),
  );
