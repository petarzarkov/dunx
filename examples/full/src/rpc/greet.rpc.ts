import { Code, ConnectError } from '@connectrpc/connect';
import { Logger } from '@dunx/core';
import { Greetings } from './greetings.service.js';
import type { MessageInitShape } from '@bufbuild/protobuf';
import type {
  CountdownRequest,
  SayRequest,
  SayResponseSchema,
} from './greet_pb.js';

type SayResult = MessageInitShape<typeof SayResponseSchema>;

/**
 * One method per RPC in `greet.proto`, named as protoc-gen-es names them:
 * `Say` becomes `say`. `connectService(GreetService, GreetRpc)` checks that
 * pairing at compile time, so a renamed RPC or a wrong argument type is a build
 * error rather than an `unimplemented` at run time.
 *
 * Constructor injection with no annotation, exactly like a controller. There are
 * no parameter decorators: a handler takes the request, and the second argument
 * is Connect's own context when a method wants headers or the abort signal.
 */
export class GreetRpc {
  constructor(
    private readonly greetings: Greetings,
    private readonly logger: Logger,
  ) {}

  say(request: SayRequest): SayResult {
    if (request.name.trim() === '') {
      // A thrown ConnectError is what a Connect or gRPC-Web client reads as a
      // status code; anything else becomes `internal` with no detail leaked.
      throw new ConnectError('name is required', Code.InvalidArgument);
    }
    const greeted = this.greetings.record(request.name);
    return { text: `Hello ${request.name}`, greeted };
  }

  async *countdown(request: CountdownRequest): AsyncGenerator<SayResult> {
    const from = Math.min(Math.max(request.from, 1), 5);
    this.logger.info(`counting down from ${from} for ${request.name}`);
    for (let i = from; i > 0; i -= 1) {
      yield { text: `${request.name} ${i}`, greeted: this.greetings.total };
    }
  }
}
