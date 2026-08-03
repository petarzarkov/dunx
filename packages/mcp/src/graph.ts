import {
  collectModules,
  describeToken,
  isUnresolved,
  readControllers,
  readDeps,
  type Ctor,
  type DepEntry,
  type ModuleRef,
  type ProviderEntry,
  type Registration,
  type ResolvedModule,
} from '@dunx/core';
import { isGateway } from '@dunx/http';

/**
 * The container graph, read through the same functions the container itself reads
 * it with: `collectModules`, `readControllers`, `readDeps` and `describeToken`.
 * Nothing about the record's key, the laziness of its thunk, or the shape of an
 * `unresolved` entry is restated here - a second reader of those would drift.
 *
 * Nothing constructs anything. `AppFactory.create` instantiates every provider and
 * awaits every async factory before it returns, so booting an app to answer "what
 * is bound" would open database connections, start queue workers and bind sockets -
 * an agent asking a question about the code would be running the code.
 */

/** What a registration binds. `role` is why it was registered, not how. */
export type ProviderKind = 'class' | 'value' | 'factory';
export type ProviderRole = 'controller' | 'gateway' | 'provider';

export type Dependency =
  | { readonly token: string }
  /**
   * A constructor parameter whose type named nothing at runtime - an interface, a
   * primitive, a union, a type-only import. It is a boot error naming that
   * parameter, and the first thing worth asking about.
   */
  | { readonly unresolved: string; readonly typeOnly?: string };

export interface ProviderNode {
  readonly token: string;
  readonly kind: ProviderKind;
  readonly role: ProviderRole;
  readonly module: string;
  /** The class a `class` binding constructs. Absent for value and factory. */
  readonly class?: string;
  readonly dependencies: readonly Dependency[];
}

export interface ModuleNode {
  readonly name: string;
  readonly imports: readonly string[];
  readonly controllers: readonly string[];
  readonly providers: readonly string[];
  readonly gateways: readonly string[];
}

const asDependency = (entry: DepEntry): Dependency =>
  isUnresolved(entry)
    ? {
        unresolved: entry.unresolved,
        // Carried through because that case has a one-line fix - drop the `type`
        // from the import - and its annotation is indistinguishable from the
        // cases that do not.
        ...(entry.typeOnly === undefined ? {} : { typeOnly: entry.typeOnly }),
      }
    : { token: describeToken(entry) };

export const dependenciesOf = (ctor: Ctor<unknown>): readonly Dependency[] =>
  readDeps(ctor).map(asDependency);

/**
 * A bare class in `providers` is shorthand for binding it to itself, the same
 * normalisation core's `readModule` does. Done per entry rather than by calling
 * `readModule`, which flattens controllers and providers into one list and so
 * cannot say which role an entry was registered under.
 */
const registrationOf = (entry: ProviderEntry): Registration =>
  typeof entry === 'function'
    ? { token: entry, provider: { kind: 'class', ctor: entry } }
    : entry;

const nodeFor = (
  entry: ProviderEntry,
  module: string,
  role: ProviderRole,
): ProviderNode => {
  const { token, provider } = registrationOf(entry);
  const base = {
    token: describeToken(token),
    kind: provider.kind,
    role,
    module,
  } as const;

  if (provider.kind === 'class') {
    return {
      ...base,
      role: isGateway(provider.ctor) ? 'gateway' : role,
      class: provider.ctor.name,
      dependencies: dependenciesOf(provider.ctor),
    };
  }

  // A factory declares its dependencies rather than having them recorded:
  // `inject()` is unusable after the first await, so `inject: [...]` is the only
  // channel it has.
  return {
    ...base,
    dependencies:
      provider.kind === 'factory'
        ? provider.deps.map((dep) => ({ token: describeToken(dep) }))
        : [],
  };
};

export const providersOf = (root: ModuleRef): readonly ProviderNode[] =>
  collectModules(root).flatMap((module) => [
    ...readControllers(module).map((controller) =>
      nodeFor(controller, module.name, 'controller'),
    ),
    ...(module.options.providers ?? []).map((entry) =>
      nodeFor(entry, module.name, 'provider'),
    ),
  ]);

/** A module reference's name, whether it is a class or a configured module. */
const refName = (ref: ModuleRef): string =>
  typeof ref === 'function' ? ref.name : ref.module.name;

/** Class bindings in a module, split by whether they are gateways. */
const classesIn = (
  module: ResolvedModule,
  gateways: boolean,
): readonly string[] =>
  (module.options.providers ?? [])
    .map(registrationOf)
    .filter(
      (registration) =>
        registration.provider.kind === 'class' &&
        isGateway(registration.provider.ctor) === gateways,
    )
    .map((registration) => describeToken(registration.token));

export const modulesOf = (root: ModuleRef): readonly ModuleNode[] =>
  collectModules(root).map((module) => ({
    name: module.name,
    imports: (module.options.imports ?? []).map(refName),
    controllers: readControllers(module).map((controller) => controller.name),
    providers: [
      ...classesIn(module, false),
      ...(module.options.providers ?? [])
        .map(registrationOf)
        .filter((registration) => registration.provider.kind !== 'class')
        .map((registration) => describeToken(registration.token)),
    ],
    gateways: classesIn(module, true),
  }));
