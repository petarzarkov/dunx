import { Controller, Get, type Input, type RouteSchemas } from '@dunx/http';
import { GreetingsService } from './greetings.service.js';

@Controller('greetings')
export class GreetingsController {
  constructor(private readonly greetings: GreetingsService) {}

  @Get('/')
  index(): { routes: readonly string[] } {
    return { routes: ['GET /greetings', 'GET /greetings/:name'] };
  }

  // With no `params` schema declared, a path param stays a string.
  // `examples/full` shows the typed, coerced version.
  @Get('/:name')
  one(input: Input<RouteSchemas>): { greeting: string; served: number } {
    return this.greetings.greet(input.req.params['name'] ?? 'world');
  }
}
