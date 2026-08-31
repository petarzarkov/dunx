import { Module } from '@dunx/core';
import { LoggerModule } from '@dunx/infra/logger';
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
 * `dunx-logging`, with `@arkv/logger` bound instead of core's `ConsoleLogger`.
 *
 * That is what `LoggerModule.forRoot()` does, and it is the configuration
 * `packages/infra/README.md` recommends, so it is what most production apps run.
 * Nothing else in the suite measured it: `dunx-logging` binds the default
 * `ConsoleLogger`, which sanitizes nothing, and the two are not the same price.
 *
 * This row exists because the difference was estimated twice and the two estimates
 * disagreed by 5.7x. Tight-loop benches put `Logger.info` at 1474 ns against
 * `ConsoleLogger`'s 543, so +931 ns; an in-process rig with no socket under it put
 * the gap at +5324 ns. A figure derived from the second went into
 * `docs/architecture/cost-of-logging.md` and had to be retracted. Neither estimate
 * is worth quoting, and this row is the thing that settles it.
 *
 * `isDevelopment: false` so the entry is JSON rather than the coloured rendering,
 * matching what `dunx-logging` writes and what a container runs.
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

@Module({
  imports: [LoggerModule.forRoot({ isDevelopment: false })],
  controllers: [BenchController],
  providers: [Greeter],
})
class AppModule {}

const app = await HttpFactory.create(AppModule, { port: port() });
await app.listen();
