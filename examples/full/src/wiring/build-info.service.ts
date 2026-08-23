import { inject, Logger, type OnInit } from '@dunx/core';
import { BUILD_STAMP, FEATURE_FLAGS, type BuildStamp } from './tokens.js';

/**
 * Both mechanisms in one class, which is supported. `logger` is a constructor
 * parameter, the default everywhere else in this app.
 *
 * The `inject()` calls are the escape hatch: a `Token<T>` is a value, not a type,
 * so the transform has nothing to record. A field initializer is the only window
 * where `inject()` works; calling it later throws saying so.
 *
 * `retries` is the third case: a parameter with a default. `number` erases, so
 * there is no token to resolve, and a default is the language already saying the
 * parameter may be absent - the container passes `undefined` and the default
 * stands rather than failing boot.
 */
export class BuildInfo implements OnInit {
  readonly #stamp = inject(BUILD_STAMP);
  readonly #flags = inject(FEATURE_FLAGS);

  constructor(
    private readonly logger: Logger,
    readonly retries = 3,
  ) {}

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
