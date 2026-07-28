import { gatewayPathOf, handlerMetaOf, type HandlerKind } from './marker.js';

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

/**
 * Walks the prototype chain of a constructed gateway and collects every marked
 * method. Most-derived wins on a repeated name; an undecorated override does not
 * shadow its decorated base, and dispatch still lands on the override because the
 * handler is bound off the instance.
 */
export const discoverGateway = (instance: object): DiscoveredGateway => {
  const klass = instance.constructor;
  const members = instance as Record<string, Invoke>;
  const handlers: DiscoveredHandler[] = [];
  const seen = new Set<string>();

  for (
    let proto = Object.getPrototypeOf(instance) as object | null;
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const [name, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(proto),
    )) {
      if (name === 'constructor' || seen.has(name)) continue;

      const meta = handlerMetaOf(descriptor.value);
      if (!meta) continue;

      seen.add(name);
      handlers.push({
        kind: meta.kind,
        event: meta.event,
        method: name,
        invoke: members[name]!.bind(instance),
      });
    }
  }

  return {
    name: klass.name,
    path: normalizePath(gatewayPathOf(klass)),
    handlers,
  };
};
