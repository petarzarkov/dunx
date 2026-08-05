import { AppError } from './errors.js';
import type { Injector } from './injector.js';
import type { Scope } from './scope.js';
import { describeToken, type InjectionToken } from './token.js';

/**
 * The ambient resolution context, swapped around every class construction.
 *
 * It carries the **scope** as well as the injector now, because a token no longer
 * resolves the same way everywhere: `inject(X)` in a field initializer has to see
 * exactly what a constructor parameter in the same class would see, which is the
 * declaring module's view.
 */
let current: { injector: Injector; scope: Scope } | undefined;

export const swapScope = (
  injector: Injector | undefined,
  scope: Scope | undefined,
): { injector: Injector | undefined; scope: Scope | undefined } => {
  const previous = current;
  current =
    injector === undefined || scope === undefined
      ? undefined
      : { injector, scope };
  return { injector: previous?.injector, scope: previous?.scope };
};

/**
 * Resolves a token from the module currently being constructed.
 *
 * Outside construction there is no module context to resolve against, and guessing
 * one - the root scope, say - would silently give a different answer than the same
 * call inside the class. So it stays an error.
 */
export const inject = <T>(token: InjectionToken<T>): T => {
  if (!current) {
    throw new AppError(
      `inject(${describeToken(token)}) was called outside of construction. inject() only ` +
        'works in a field initializer or constructor of a class the container builds, ' +
        'because that is what decides which module scope the token resolves from.',
    );
  }
  return current.injector.get(token, current.scope);
};
