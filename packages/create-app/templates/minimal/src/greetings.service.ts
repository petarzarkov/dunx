import { Logger, type OnInit } from '@dunx/core';

/**
 * A provider. No decorator, no registration boilerplate - being listed in a
 * module's `providers` is what makes it injectable.
 *
 * `Logger` in the constructor is the whole dependency injection story: the
 * container reads the parameter's type and resolves it. Nothing bound `Logger`
 * here, so it gets core's default `ConsoleLogger`, which writes one JSON line
 * per entry and needs no dependency.
 */
export class GreetingsService implements OnInit {
  #greeted = 0;

  constructor(private readonly logger: Logger) {}

  /** Runs after the whole graph is constructed, in dependency order. */
  onInit(): void {
    this.logger.info('greetings ready');
  }

  greet(name: string): { greeting: string; served: number } {
    this.#greeted++;
    return { greeting: `hello, ${name}`, served: this.#greeted };
  }
}
