export interface Token<T> {
  readonly description: string;
  // Phantom. Never assigned — it exists so Token<A> and Token<B> are distinct
  // types rather than both being { description: string }.
  readonly resolves?: T;
}

// DI happens in field initializers, so a constructor the container can call
// takes no arguments. A class requiring constructor arguments fails to assign
// here, which is the intended error.
export type Ctor<T> = new () => T;

// An abstract class cannot be constructed, so it is usable as a token but not as
// a `useClass` target or a bare `providers` entry. This is how a contract gets
// injected without needing token() at all.
export type AbstractCtor<T> = abstract new (...args: never[]) => T;

export type InjectionToken<T> = AbstractCtor<T> | Token<T>;

export const token = <T>(description: string): Token<T> => ({ description });

export const isCtor = <T>(value: InjectionToken<T>): value is Ctor<T> =>
  typeof value === 'function';

// Narrows on the union directly: excluding Ctor would leave AbstractCtor behind,
// since Ctor is a subtype of it.
export const describeToken = (value: InjectionToken<unknown>): string =>
  typeof value === 'function' ? value.name : value.description;
