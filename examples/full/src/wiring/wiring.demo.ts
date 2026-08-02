import { AppError, inject, Logger, token } from '@dunx/core';
import { BuildInfo } from './build-info.service.js';
import { BUILD_STAMP, FEATURE_FLAGS } from './tokens.js';

/**
 * The DI primitives, narrated. Everything else in this app uses constructor
 * injection and nothing else, which is the point — this exists so the escape
 * hatches are shown once rather than never.
 */
export class WiringDemo {
  constructor(
    private readonly logger: Logger,
    private readonly build: BuildInfo,
  ) {}

  demonstrate(): void {
    const stamp = this.build.describe();
    this.logger.info(
      `token(${BUILD_STAMP.description}) -> ${JSON.stringify({ revision: stamp.revision })}`,
    );
    this.logger.info(
      `token(${FEATURE_FLAGS.description}) -> [${stamp.flags.join(', ')}], ` +
        `enabled("transactions") = ${this.build.enabled('transactions')}`,
    );
    this.logger.info(
      'both reached with inject() in a field initializer, alongside a constructor-injected Logger',
    );

    // Two tokens with the same description are still different tokens: `token()`
    // returns a fresh object every call and identity is what the container keys on.
    const first = token<number>('duplicate');
    const second = token<number>('duplicate');
    this.logger.info(
      `token('duplicate') === token('duplicate') -> ${first === second} — identity, not the string`,
    );

    // `inject()` only works while the container is constructing something. Outside
    // that window it throws with a message saying so, rather than returning
    // `undefined` and failing somewhere unrelated later.
    try {
      inject(BUILD_STAMP);
    } catch (error) {
      const why = error instanceof AppError ? error.message : String(error);
      this.logger.info(`inject() outside construction -> ${why.slice(0, 96)}…`);
    }
  }
}
