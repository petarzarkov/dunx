export interface Token<T> {
  readonly description: string;
  // Phantom. Never assigned - it exists so Token<A> and Token<B> are distinct
  // types rather than both being { description: string }.
  readonly resolves?: T;
}

// Any constructor is callable: `@dunx/transform` records each class's parameter
// types, and the container resolves them before calling `new`. `never[]` is what
// makes an arbitrary signature assignable here - parameters are contravariant.
export type Ctor<T> = new (...args: never[]) => T;

// An abstract class cannot be constructed, so it is usable as a token but not as
// a `useClass` target or a bare `providers` entry. This is how a contract gets
// injected without needing token() at all.
export type AbstractCtor<T> = abstract new (...args: never[]) => T;

/**
 * A method a decorator may mark, whatever it takes. `never[]` for the same reason
 * `Ctor` uses it: it is what makes an arbitrary method signature assignable, so a
 * handler declares the payload type it expects rather than the widest one.
 *
 * `@dunx/http`'s gateways and `@dunx/infra`'s job and schedule decorators all
 * mark methods, and each used to declare this line itself.
 */
export type HandlerMethod = (...args: never[]) => unknown;

export type InjectionToken<T> = AbstractCtor<T> | Token<T>;

export const token = <T>(description: string): Token<T> => ({ description });

export const isCtor = <T>(value: InjectionToken<T>): value is Ctor<T> =>
  typeof value === 'function';

// Narrows on the union directly: excluding Ctor would leave AbstractCtor behind,
// since Ctor is a subtype of it.
export const describeToken = (value: InjectionToken<unknown>): string =>
  typeof value === 'function' ? value.name : value.description;
