/**
 * The app all three dunx subjects serve: one controller, one injected service, the
 * same four routes. Holding it in one place is what makes their rows comparable -
 * the only thing that differs between them is the module wiring each one exists to
 * measure.
 *
 * It is not in `shared.ts` because every subject imports that file. An `@dunx/http`
 * import there would put the framework in the boot path of the Express, Fastify,
 * Hono, Elysia, Nest and raw `Bun.serve` rows, and the harness records a startup
 * time and `rssBootMiB` for each of them.
 */
import {
  Controller,
  Get,
  type Input,
  Post,
  type RouteSchemas,
} from '@dunx/http';
import { connectBunIo, readBunIo } from './io/bun.js';
import { type IoPayload, ioEnabled } from './io/contract.js';
import { echo, jsonPayload, personSchema, PLAINTEXT } from './shared.js';

export class Greeter {
  text(): string {
    return PLAINTEXT;
  }

  payload(): { message: string } {
    return jsonPayload();
  }
}

const plain = {} as const satisfies RouteSchemas;
const declared = { status: 200 } as const satisfies RouteSchemas;
const validate = {
  body: personSchema,
  status: 200,
} as const satisfies RouteSchemas;

// A constructor-injected dependency, resolved by @dunx/transform's preload. It is
// here because that is how a real dunx app is written, and its cost belongs in the
// startup number rather than being quietly left out.
@Controller()
export class BenchController {
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

  // A declared route rather than a conditional one: a controller's routes are read
  // off the class at boot. `readBunIo` throws unless the harness enabled the
  // scenario, and only the `io` scenario asks for this path.
  @Get('/io', declared)
  io(): Promise<IoPayload> {
    return readBunIo();
  }
}

/** Opens the connection `/io` reads from, when the harness asked for that scenario. */
export const connectIo = async (): Promise<void> => {
  if (ioEnabled()) await connectBunIo();
};
