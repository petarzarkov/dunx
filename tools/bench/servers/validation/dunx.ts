/**
 * The `@dunx/http` side of the comparison. `/validate` is the framework doing the
 * work - a declared `body` schema, so the route takes the async path through the
 * input reader. The two `/manual-*` routes declare nothing and do the same work by
 * hand inside the handler, which keeps them on the synchronous dispatch path.
 *
 * Together they split dunx's cost in two: `/manual-parse` against raw `Bun.serve`
 * is dispatch, and `/validate` against `/manual-validate` is the input reader.
 *
 * `$VALIDATOR` chooses the library; nothing else varies between runs.
 */
import { Module } from '@dunx/core';
import {
  Controller,
  Get,
  HttpFactory,
  type Input,
  Post,
  type RouteSchemas,
} from '@dunx/http';
import { echo, PLAINTEXT, port } from '../shared.js';
import type { Person } from '../shared.js';
import { loadSchema, validatorFromEnv } from './schemas.js';

const schema = await loadSchema(validatorFromEnv());
const { validate } = schema['~standard'];

const declared = { body: schema, status: 200 } satisfies RouteSchemas;
const undeclared = { status: 200 } as const satisfies RouteSchemas;

interface Echoed {
  name: string;
  age: number;
}

@Controller()
class ValidateController {
  @Get('/plaintext')
  plaintext(): Response {
    return new Response(PLAINTEXT);
  }

  @Post('/validate', declared)
  validate(input: Input<typeof declared>): Echoed {
    return echo(input.body);
  }

  @Post('/manual-parse', undeclared)
  async manualParse(input: Input<typeof undeclared>): Promise<Echoed> {
    return echo((await input.req.json()) as Person);
  }

  @Post('/manual-validate', undeclared)
  async manualValidate(input: Input<typeof undeclared>): Promise<Echoed> {
    const result = validate(await input.req.json());
    const settled = result instanceof Promise ? await result : result;
    if (settled.issues !== undefined) throw new Error('invalid');
    return echo(settled.value);
  }
}

@Module({ controllers: [ValidateController] })
class AppModule {}

const app = await HttpFactory.create(AppModule, {
  port: port(),
  requestLogging: false,
});
await app.listen();
