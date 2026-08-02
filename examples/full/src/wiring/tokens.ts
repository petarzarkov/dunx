import { token, type Token } from '@dunx/core';

export interface BuildStamp {
  readonly startedAt: string;
  readonly revision: string;
}

/**
 * `token()` - the escape hatch for a value that has **no class to hang off**. This
 * one is a plain object read from the environment; there is no `BuildStampService`
 * worth writing, and inventing one purely to have a token would be the wrong trade.
 *
 * Everywhere a class exists, use the class. `Token<T>` is unforgeable and typed,
 * but it is a second thing to import at every injection site, and it cannot be
 * written as a constructor parameter type - so the compiler transform cannot see
 * it and `inject()` is the only way to reach it.
 *
 * That asymmetry is the reason the rest of this app uses zero of these: the
 * repository injects `SyncDatabase`, the controller injects the repository, and no
 * token is named anywhere.
 */
export const BUILD_STAMP: Token<BuildStamp> = token<BuildStamp>('BuildStamp');

/** Same idea, a primitive - the case where a class is most obviously silly. */
export const FEATURE_FLAGS: Token<ReadonlySet<string>> =
  token<ReadonlySet<string>>('FeatureFlags');
