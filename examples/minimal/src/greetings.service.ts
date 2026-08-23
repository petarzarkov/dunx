import { Logger, type OnInit } from '@dunx/core';

/** A provider is a plain class. Listing it in a module's `providers` is what
 * makes it injectable; the container reads `Logger` off the constructor. */
export class GreetingsService implements OnInit {
  #greeted = 0;

  constructor(private readonly logger: Logger) {}

  onInit(): void {
    this.logger.info('greetings ready');
  }

  greet(name: string): { greeting: string; served: number } {
    this.#greeted++;
    return { greeting: `hello, ${name}`, served: this.#greeted };
  }
}
