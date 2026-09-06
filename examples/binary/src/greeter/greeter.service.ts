import { Logger, type OnInit } from '@dunx/core';

/**
 * A stateful, injected provider. The container reads `Logger` off the
 * constructor, which is what a compiled binary has to reproduce with no plugin
 * running at load time - see `scripts/build.ts`.
 */
export class GreeterService implements OnInit {
  #served = 0;

  constructor(private readonly logger: Logger) {}

  onInit(): void {
    this.logger.info('greeter ready');
  }

  greet(name: string): { greeting: string; served: number } {
    this.#served++;
    // To stderr, deliberately: this line must not land in the JSON a caller
    // parses off stdout. `cli.module.ts`'s stream transport is what routes it.
    this.logger.info('greeted', { name });
    return { greeting: `hello, ${name}`, served: this.#served };
  }
}
