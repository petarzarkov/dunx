import { DunxError } from './errors.js';
import type { Injector } from './injector.js';
import { describeToken, type InjectionToken } from './token.js';

let current: Injector | undefined;

export const swapInjector = (
  next: Injector | undefined,
): Injector | undefined => {
  const previous = current;
  current = next;
  return previous;
};

export const inject = <T>(token: InjectionToken<T>): T => {
  if (!current) {
    throw new DunxError(
      `inject(${describeToken(token)}) was called outside of construction. inject() only ` +
        'works in a field initializer or constructor of a class the container builds.',
    );
  }
  return current.get(token);
};
