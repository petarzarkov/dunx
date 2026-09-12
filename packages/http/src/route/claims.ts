import { AppError } from '@dunx/core';

/**
 * What has claimed each path, so a second claim is a boot error naming both
 * rather than a silent overwrite. Routes and RPCs share it because the failure
 * is the same one: a table keyed by path keeps whichever registered last.
 */
export class PathClaims {
  readonly #owners = new Map<string, string>();
  readonly #noun: string;
  readonly #remedy: string;

  constructor(noun: string, remedy: string) {
    this.#noun = noun;
    this.#remedy = remedy;
  }

  /** Records `owner` against `key`, or throws naming the one already there. */
  claim(key: string, owner: string): void {
    const existing = this.#owners.get(key);
    if (existing !== undefined) {
      throw new AppError(
        `${this.#noun} collision: ${key} is declared by ${existing} and by ` +
          `${owner}. ${this.#remedy}`,
      );
    }
    this.#owners.set(key, owner);
  }
}
