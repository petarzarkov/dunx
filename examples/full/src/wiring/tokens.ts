import { token, type Token } from '@dunx/core';

export interface BuildStamp {
  readonly startedAt: string;
  readonly revision: string;
}

/**
 * `token()` - the escape hatch for a value with no class to hang off. A `Token<T>`
 * cannot be written as a constructor parameter type, so the transform never sees
 * it and `inject()` is the only way to reach it. Use a class wherever one exists;
 * the rest of this app uses none of these.
 */
export const BUILD_STAMP: Token<BuildStamp> = token<BuildStamp>('BuildStamp');

/** Same idea with a primitive. */
export const FEATURE_FLAGS: Token<ReadonlySet<string>> =
  token<ReadonlySet<string>>('FeatureFlags');
