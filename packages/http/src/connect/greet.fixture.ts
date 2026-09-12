import type { Message, MessageInitShape } from '@bufbuild/protobuf';
import {
  fileDesc,
  messageDesc,
  serviceDesc,
  type GenFile,
  type GenMessage,
  type GenService,
} from '@bufbuild/protobuf/codegenv2';

/**
 * What `protoc-gen-es` emits for this `greet/v1/greet.proto`, inlined rather
 * than generated so the suite needs no buf toolchain:
 *
 * ```proto
 * message SayRequest { string name = 1; }
 * message SayResponse { string text = 1; }
 * service GreetService {
 *   rpc Say(SayRequest) returns (SayResponse) {}
 *   rpc Countdown(SayRequest) returns (stream SayResponse) {}
 * }
 * ```
 *
 * The generated form rather than a descriptor built at run time, because the
 * typing is the thing under test: `connectService` pairs a `GenService` with a
 * class and reports a missing or mistyped method, and a bare `DescService`
 * carries no method names to check against.
 */
const file: GenFile = fileDesc(
  'ChRncmVldC92MS9ncmVldC5wcm90bxIIZ3JlZXQudjEiGgoKU2F5UmVxdWVzdBIMCgRuYW1l' +
    'GAEgASgJIhsKC1NheVJlc3BvbnNlEgwKBHRleHQYASABKAkyggEKDEdyZWV0U2VydmljZRI0' +
    'CgNTYXkSFC5ncmVldC52MS5TYXlSZXF1ZXN0GhUuZ3JlZXQudjEuU2F5UmVzcG9uc2UiABI8' +
    'CglDb3VudGRvd24SFC5ncmVldC52MS5TYXlSZXF1ZXN0GhUuZ3JlZXQudjEuU2F5UmVzcG9u' +
    'c2UiADABYgZwcm90bzM',
);

export type SayRequest = Message<'greet.v1.SayRequest'> & {
  name: string;
};

export const SayRequestSchema: GenMessage<SayRequest> = messageDesc(file, 0);

export type SayResponse = Message<'greet.v1.SayResponse'> & {
  text: string;
};

export const SayResponseSchema: GenMessage<SayResponse> = messageDesc(file, 1);

export const GreetService: GenService<{
  say: {
    methodKind: 'unary';
    input: typeof SayRequestSchema;
    output: typeof SayResponseSchema;
  };
  countdown: {
    methodKind: 'server_streaming';
    input: typeof SayRequestSchema;
    output: typeof SayResponseSchema;
  };
}> = serviceDesc(file, 0);

type Said = MessageInitShape<typeof SayResponseSchema>;

/** A private field proves `this` survives the call, which is what makes an
 * injected class usable as a Connect implementation. */
export class GreetRpc {
  readonly #greeting: string;

  constructor(greeting = 'Hello') {
    this.#greeting = greeting;
  }

  say(request: SayRequest): Said {
    return { text: `${this.#greeting} ${request.name}` };
  }

  async *countdown(request: SayRequest): AsyncGenerator<Said> {
    for (let i = 3; i > 0; i -= 1) {
      yield { text: `${request.name} ${i}` };
    }
  }
}

/** Keeps a stream open and records the per-call signal, so a test can watch what
 * `onShutdown` does to a call that is still running. */
export class CapturingRpc {
  signal: AbortSignal | undefined;

  say(request: SayRequest): Said {
    return { text: request.name };
  }

  async *countdown(
    _request: SayRequest,
    context: { signal: AbortSignal },
  ): AsyncGenerator<Said> {
    this.signal = context.signal;
    yield { text: 'first' };
    await new Promise((resolve) => {
      context.signal.addEventListener('abort', resolve, { once: true });
    });
  }
}

/** Pauses longer than `Bun.serve`'s default 10s idle timeout between two
 * messages, which is what the keep-alive has to survive. */
export class SlowRpc {
  // Defaulted, so `ctor.length` is 0 and the container builds it without the
  // transform preload, like every other fixture here.
  constructor(private readonly gapMs = 12_500) {}

  say(request: SayRequest): Said {
    return { text: request.name };
  }

  async *countdown(request: SayRequest): AsyncGenerator<Said> {
    yield { text: `${request.name} first` };
    await Bun.sleep(this.gapMs);
    yield { text: `${request.name} second` };
  }
}
