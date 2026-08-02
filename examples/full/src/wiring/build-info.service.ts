import { inject, Logger, type OnInit } from '@dunx/core';
import { BUILD_STAMP, FEATURE_FLAGS, type BuildStamp } from './tokens.js';

/**
 * The two mechanisms in one class, which is supported and occasionally the right
 * answer.
 *
 * `logger` is a **constructor parameter**: `@dunx/transform` recorded its type at
 * load time, so it needs no annotation at all. That is the default and what almost
 * everything in this app uses.
 *
 * The two `inject()` calls are the escape hatch. A `Token<T>` cannot be written as
 * a parameter type - it is a value, not a type - so the transform has nothing to
 * record and a constructor parameter could never reach it. `inject()` in a **field
 * initializer** runs inside the container's construction of this object, which is
 * the only window where it works; calling it later throws with that message.
 */
export class BuildInfo implements OnInit {
  readonly #stamp = inject(BUILD_STAMP);
  readonly #flags = inject(FEATURE_FLAGS);

  constructor(private readonly logger: Logger) {}

  onInit(): void {
    this.logger.info(
      `build ${this.#stamp.revision}, flags [${[...this.#flags].join(', ')}]`,
    );
  }

  describe(): BuildStamp & { readonly flags: readonly string[] } {
    return { ...this.#stamp, flags: [...this.#flags] };
  }

  enabled(flag: string): boolean {
    return this.#flags.has(flag);
  }
}
