import {
  ConsoleLogger,
  Logger,
  Module,
  provide,
  RequestContext,
} from '@dunx/core';
import {
  Controller,
  Get,
  HttpFactory,
  type Input,
  type Middleware,
  type Next,
  Post,
  REQUEST_ID_HEADER,
  type RouteContext,
  type RouteSchemas,
} from '@dunx/http';
import type { BunRequest } from 'bun';
import { echo, jsonPayload, personSchema, PLAINTEXT, port } from '../shared.js';
import {
  DiscardLogger,
  isLoggingVariant,
  loggingVariants,
  SerializeOnlyLogger,
  sink,
  stepOf,
  TimestampLogger,
  type LoggingVariant,
} from './variants.js';

const raw = process.env['LOGGING_VARIANT'] ?? 'off';
if (!isLoggingVariant(raw)) {
  throw new Error(
    `Unknown LOGGING_VARIANT "${raw}". One of: ${loggingVariants.join(', ')}`,
  );
}
const variant: LoggingVariant = raw;
const step = stepOf(variant);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASSTHRU = stepOf('passthru');
const PATH = stepOf('path');
const HEADERS = stepOf('headers');
const REQUEST_ID = stepOf('requestid');
const RESP_HEADER = stepOf('respheader');
const ENTRY = stepOf('entry');

/**
 * `RequestLoggingMiddleware` truncated at `step`. Each branch is decided once, at
 * module scope, against a constant - so a variant pays for the work it declares
 * and not for the check.
 */
class StepMiddleware implements Middleware {
  constructor(private readonly context: RequestContext) {}

  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response> {
    if (step === PASSTHRU) return next();

    const url = req.url;
    const from = url.indexOf('/', url.indexOf('://') + 3);
    const mark = url.indexOf('?', from);
    const path =
      from === -1 ? '/' : mark === -1 ? url.slice(from) : url.slice(from, mark);
    if (step === PATH) {
      sink.stamp = path;
      return next();
    }

    const inbound = req.headers.get(REQUEST_ID_HEADER);
    sink.stamp = req.headers.get('user-agent') ?? '';
    if (step === HEADERS) {
      sink.line = inbound ?? '';
      return next();
    }

    // The shipped middleware's `traceId`, copied for the same reason the rest of
    // this class is: an inbound id is only trusted if it is a UUID, so the row has
    // to pay for the check or the step below it inherits the cost.
    const requestId =
      inbound !== null && inbound.length === 36 && UUID.test(inbound)
        ? inbound
        : crypto.randomUUID();
    if (step === REQUEST_ID) {
      sink.line = requestId;
      return next();
    }

    return this.context.runWithContext(
      {
        requestId,
        method: ctx.method,
        event: path,
        flow: 'http',
        context: `${ctx.controller}.${ctx.handler}`,
      },
      // Synchronous and `.then`, not `async`/`await`, because that is what the
      // shipped middleware does - an async scope callback measured 0.44 µs dearer.
      () => {
        const settled = next();
        if (step < RESP_HEADER) return settled;
        return settled.then((response) => {
          response.headers.set(REQUEST_ID_HEADER, requestId);
          return response;
        });
      },
    );
  }
}

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

const loggerOverride = (): ReturnType<typeof provide<Logger>> | undefined => {
  if (variant === 'entry') return provide(Logger, { useClass: DiscardLogger });
  if (variant === 'timestamp') {
    return provide(Logger, { useClass: TimestampLogger });
  }
  if (variant === 'serialize') {
    return provide(Logger, {
      useFactory: (context: RequestContext) => new SerializeOnlyLogger(context),
      inject: [RequestContext] as const,
    });
  }
  // The shipped logger with batching turned off: one `console.log` per entry,
  // which is what dunx did before `bun run logging` said what it cost.
  if (variant === 'unbatched') {
    return provide(Logger, {
      useFactory: (context: RequestContext) =>
        new ConsoleLogger(context, 'info', false),
      inject: [RequestContext] as const,
    });
  }
  return undefined;
};

const override = loggerOverride();
const stepped = step > stepOf('off') && step < ENTRY;

@Module({
  controllers: [BenchController],
  providers: [Greeter, StepMiddleware, ...(override ? [override] : [])],
})
class AppModule {}

const app = await HttpFactory.create(AppModule, {
  port: port(),
  requestLogging: step < ENTRY ? false : {},
  middleware: stepped ? [StepMiddleware] : [],
});
await app.listen();
