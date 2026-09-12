import type { App } from './app.js';
import {
  readControllers,
  type ModuleRef,
  type ProviderEntry,
  type ResolvedModule,
} from './module.js';
import type { Ctor, HandlerMethod, InjectionToken } from './token.js';

/**
 * What discovery needs from the container: resolve a token as a named module
 * sees it.
 *
 * The container itself rather than a `(token) => unknown` callback. A callback is
 * free to ignore the module it is handed - every `@dunx/infra/queue` call site did,
 * so the scoped resolution this signature promised was not happening - and a
 * one-argument lambda is assignable to a two-argument function type, so nothing
 * caught it. Passing `app` leaves nothing to get wrong.
 */
export type ScopedResolver = Pick<App, 'get'>;

/**
 * A method a decorator marked, found by walking a prototype chain.
 *
 * `value` is the function the decorator wrote onto, not the member read off the
 * instance. Any further marker a second decorator left is on that object, and it
 * is the only place the metadata can have come from.
 */
export interface MarkedMethod<M> {
  readonly name: string;
  readonly meta: M;
  readonly value: object;
}

/**
 * Every marked method on a prototype chain, most-derived first, names deduped. A
 * decorator defines a symbol-keyed property on the method function, so nothing
 * accumulates at class-definition time; three packages had written this walk
 * identically before it moved here.
 *
 * Most-derived wins on a repeated name, so an undecorated override does not
 * inherit its base's marker. Dispatch still lands on the override, since callers
 * bind off the instance.
 *
 * `Object.prototype` ends the walk and `constructor` is skipped.
 */
export const markedMethods = <M>(
  start: object | null,
  metaOf: (value: unknown) => M | undefined,
): readonly MarkedMethod<M>[] => {
  const found: MarkedMethod<M>[] = [];
  const seen = new Set<string>();

  for (
    let proto = start;
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const [name, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(proto),
    )) {
      if (name === 'constructor' || seen.has(name)) continue;

      const meta = metaOf(descriptor.value);
      if (meta === undefined) continue;

      seen.add(name);
      found.push({ name, meta, value: descriptor.value as object });
    }
  }

  return found;
};

/**
 * The class a `providers` entry would construct, or nothing for a value or factory
 * provider - neither is a discovery candidate, since there is no prototype chain
 * to read until it is built and building it to find out is the ordering trap the
 * marker technique avoids.
 *
 * Here because three packages walk `providers` looking for marked methods.
 */
export const classOf = (
  entry: ProviderEntry,
): { token: InjectionToken<unknown>; ctor: Ctor<unknown> } | undefined => {
  if (typeof entry === 'function') return { token: entry, ctor: entry };
  return entry.provider.kind === 'class'
    ? { token: entry.token, ctor: entry.provider.ctor }
    : undefined;
};

/**
 * An instance of `ctor` with its prototype chain and nothing behind it: every
 * method is reachable and `instance.constructor` still resolves to the class, but
 * no constructor runs, so a class whose dependencies are absent can still be read.
 *
 * This is what makes route, gateway and OpenAPI discovery constructing-free. Three
 * call sites across `@dunx/http` and `@dunx/openapi` each cast to a local
 * `Prototyped` interface to do it.
 */
export const inertInstance = (ctor: Ctor<unknown>): object =>
  Object.create(
    (ctor as unknown as { readonly prototype: object }).prototype,
  ) as object;

/**
 * A marked method read off a constructed provider, bound to it.
 *
 * `H` is the signature the marker's own decorator enforces at the declaration
 * site, so a caller states it once here rather than casting every `handler`.
 */
export interface DiscoveredMethod<M, H extends HandlerMethod = HandlerMethod> {
  /** The declaring class's name, for error messages and boot logs. */
  readonly provider: string;
  readonly method: string;
  readonly meta: M;
  /** Already bound to its instance. */
  readonly handler: H;
}

/**
 * Every marked method on an instance's prototype chain, bound to that instance.
 * Most-derived wins on a repeated name; dispatch still lands on an override,
 * since the member is read off the instance rather than off the prototype the
 * marker was found on.
 */
export const markedMethodsOn = <M, H extends HandlerMethod = HandlerMethod>(
  instance: object,
  metaOf: (value: unknown) => M | undefined,
): readonly DiscoveredMethod<M, H>[] => {
  const provider = instance.constructor.name;
  const members = instance as Record<string, HandlerMethod>;

  return markedMethods(
    Object.getPrototypeOf(instance) as object | null,
    metaOf,
  ).map(({ name, meta }) => ({
    provider,
    method: name,
    meta,
    handler: members[name]!.bind(instance) as H,
  }));
};

/**
 * Every marked method the module graph declares, each resolved from the scope
 * that owns it.
 *
 * Each candidate is resolved as the module that declared it would, so a provider
 * two modules bind differently gives each module's own instance rather than
 * whichever one a bare `app.get()` picks. A class is scanned once, on the first
 * module that declares it.
 *
 * `@dunx/infra`'s job and schedule discovery and `@dunx/core`'s `EventRegistry`
 * had written this walk identically; only the marker differs.
 */
export const discoverMarked = <M, H extends HandlerMethod = HandlerMethod>(
  modules: readonly ResolvedModule[],
  container: ScopedResolver,
  metaOf: (value: unknown) => M | undefined,
): readonly DiscoveredMethod<M, H>[] => {
  const found: DiscoveredMethod<M, H>[] = [];
  const scanned = new Set<Ctor<unknown>>();

  const scan = (
    token: InjectionToken<unknown>,
    ctor: Ctor<unknown>,
    from: ModuleRef,
  ): void => {
    if (scanned.has(ctor)) return;
    if (markedMethods(ctor.prototype as object | null, metaOf).length === 0) {
      return;
    }
    scanned.add(ctor);
    found.push(
      ...markedMethodsOn<M, H>(container.get(token, from) as object, metaOf),
    );
  };

  for (const module of modules) {
    for (const entry of module.options.providers ?? []) {
      const candidate = classOf(entry);
      if (candidate) scan(candidate.token, candidate.ctor, module.ref);
    }
    for (const controller of readControllers(module)) {
      scan(controller, controller, module.ref);
    }
  }

  return found;
};
