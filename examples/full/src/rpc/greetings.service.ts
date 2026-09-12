import { Logger } from '@dunx/core';

/**
 * An ordinary provider, injected into the RPC implementation by constructor.
 * Nothing here knows it is behind protobuf.
 */
export class Greetings {
  #greeted = 0;

  constructor(private readonly logger: Logger) {}

  record(name: string): number {
    this.#greeted += 1;
    this.logger.debug(`greeted ${name}`, { total: this.#greeted });
    return this.#greeted;
  }

  get total(): number {
    return this.#greeted;
  }
}
