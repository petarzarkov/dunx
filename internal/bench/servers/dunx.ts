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

// A constructor-injected dependency, resolved by @dunx/transform's preload. It is
// here because that is how a real dunx app is written, and its cost belongs in the
// startup number rather than being quietly left out.
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

// `requestLogging: false` because **no other subject logs**, and comparing a
// framework that writes a structured line per request against seven that write
// nothing measures the logger, not the framework. The cost of dunx's default is
// not hidden - it is its own subject, `dunx-logging`, in the same table.
const app = await HttpFactory.create(AppModule, {
  port: port(),
  requestLogging: false,
});
await app.listen();
