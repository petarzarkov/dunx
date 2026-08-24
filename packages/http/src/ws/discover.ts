import {
  AppError,
  classOf,
  markedMethods,
  type Ctor,
  type InjectionToken,
  type MarkedMethod,
  type ResolvedModule,
} from '@dunx/core';
import {
  gatewayPathOf,
  handlerMetaOf,
  isGateway,
  type HandlerKind,
  type HandlerMeta,
} from './marker.js';

/**
 * A discovered handler, already bound to its instance. Every kind has a different
 * signature, so the runtime holds them loosely and the decorators are what keep
 * the declared shapes honest.
 */
export type Invoke = (...args: readonly unknown[]) => unknown;

export interface DiscoveredHandler {
  readonly kind: HandlerKind;
  readonly event: string | undefined;
  readonly method: string;
  readonly invoke: Invoke;
}

export interface DiscoveredGateway {
  readonly name: string;
  readonly path: string;
  readonly handlers: readonly DiscoveredHandler[];
}

/** `chat` and `/chat/` both become `/chat`; an empty path becomes `/`. */
export const normalizePath = (path: string): string => {
  const joined = `/${path}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : '/';
};

/** Every marked method on a prototype chain, most-derived first, names deduped. */
const eachHandler = (
  start: object | null,
): readonly MarkedMethod<HandlerMeta>[] => markedMethods(start, handlerMetaOf);

/**
 * Walks the prototype chain of a constructed gateway and collects every marked
 * method. Most-derived wins on a repeated name; an undecorated override does not
 * shadow its decorated base, and dispatch still lands on the override because the
 * handler is bound off the instance.
 */
export const discoverGateway = (instance: object): DiscoveredGateway => {
  const klass = instance.constructor;
  const members = instance as Record<string, Invoke>;

  return {
    name: klass.name,
    path: normalizePath(gatewayPathOf(klass)),
    handlers: eachHandler(Object.getPrototypeOf(instance) as object | null).map(
      ({ name, meta }) => ({
        kind: meta.kind,
        event: meta.event,
        method: name,
        invoke: members[name]!.bind(instance),
      }),
    ),
  };
};

/**
 * The name of the first handler a class declares, without constructing it. A
 * provider that declares one but is not a gateway would silently never receive a
 * frame, so that becomes a boot error naming the method.
 */
const findHandlerMethod = (ctor: Ctor<unknown>): string | undefined =>
  eachHandler(ctor.prototype as object | null)[0]?.name;

/**
 * Gateways are declared in `@Module({ providers })` like any other injectable and
 * found here by their marker - the same discovery-by-inspection controllers get,
 * with no second registration key to keep in step.
 */
export const discoverGateways = (
  modules: readonly ResolvedModule[],
  resolve: (token: InjectionToken<unknown>) => unknown,
): readonly DiscoveredGateway[] => {
  const discovered: DiscoveredGateway[] = [];

  for (const module of modules) {
    for (const entry of module.options.providers ?? []) {
      const candidate = classOf(entry);
      if (!candidate) continue;

      if (isGateway(candidate.ctor)) {
        discovered.push(discoverGateway(resolve(candidate.token) as object));
        continue;
      }
      // Otherwise its handlers could never run, and nothing would say so.
      const orphan = findHandlerMethod(candidate.ctor);
      if (orphan !== undefined) {
        throw new AppError(
          `${candidate.ctor.name}.${orphan}() is a websocket handler, but ` +
            `${candidate.ctor.name} is not a gateway. Decorate the class with ` +
            '@Gateway(path), or drop the handler decorator.',
        );
      }
    }
  }

  return discovered;
};
