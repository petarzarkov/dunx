import { Module } from '@dunx/core';
import {
  Controller,
  Get,
  HttpFactory,
  type Input,
  Post,
  type RouteSchemas,
} from '@dunx/http';
import { echo, jsonPayload, personSchema, PLAINTEXT, port } from './shared.js';

/**
 * `@dunx/http` exactly as `HttpFactory.create` leaves it: `requestLogging` on,
 * which is the default and therefore what an app gets unless it opts out.
 *
 * It is a separate subject rather than the primary one because no other subject
 * in the suite logs anything, so this row measures dunx's default *observability*
 * against seven servers that are silent. Both numbers matter and both are here:
 * `dunx` is the framework, `dunx-logging` is the framework plus a structured line
 * per request written to stdout.
 *
 * Its stdout is `/dev/null`, so this does not measure terminal rendering - but it
 * does measure building the entry, `JSON.stringify`, and a real `write(2)`.
 *
 * It used to be a pipe **nobody read**, which is not a measurement of dunx at all:
 * 64 KiB in, the pipe is full, and the server parks on every further write. That
 * alone was worth 2.68 µs/request - see `bun run logging` and ARCHITECTURE.md.
 */
class Greeter {
  text(): string {
    return PLAINTEXT;
  }

  payload(): { message: string } {
    return jsonPayload();
  }
}

const plain = {} as const satisfies RouteSchemas;
const validate = {
  body: personSchema,
  status: 200,
} as const satisfies RouteSchemas;

@Controller()
class BenchController {
  constructor(private readonly greeter: Greeter) {}

  @Get('/plaintext')
  plaintext(): Response {
    return new Response(this.greeter.text());
  }

  @Get('/json')
  json(): { message: string } {
    return this.greeter.payload();
  }

  @Get('/params/:id', plain)
  params(input: Input<typeof plain>): { id: string | undefined } {
    return { id: input.req.params['id'] };
  }

  @Post('/validate', validate)
  validate(input: Input<typeof validate>): { name: string; age: number } {
    return echo(input.body);
  }
}

@Module({ controllers: [BenchController], providers: [Greeter] })
class AppModule {}

const app = await HttpFactory.create(AppModule, { port: port() });
await app.listen();
