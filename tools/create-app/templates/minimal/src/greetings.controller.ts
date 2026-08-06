import { Controller, Get, type Input, type RouteSchemas } from '@dunx/http';
import { GreetingsService } from './greetings.service.js';

/**
 * A controller is a provider with routes on it. `GreetingsService` in the
 * constructor is resolved the same way the service's own `Logger` was.
 *
 * Returning a plain object is enough - `@dunx/http` serialises it. There is no
 * `Response.json()` to remember and no `res` to forget to send.
 */
@Controller('greetings')
export class GreetingsController {
  constructor(private readonly greetings: GreetingsService) {}

  @Get('/')
  index(): { routes: readonly string[] } {
    return { routes: ['GET /greetings', 'GET /greetings/:name'] };
  }

  /**
   * No schemas are declared, so a path param stays on `input.req.params` as a
   * string. Declaring a `params` schema is what makes it typed and coerced -
   * `examples/full` does that; this one is showing the shape, not validation.
   */
  @Get('/:name')
  one(input: Input<RouteSchemas>): { greeting: string; served: number } {
    return this.greetings.greet(input.req.params['name'] ?? 'world');
  }
}
