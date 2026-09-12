# RPC

`@dunx/http/connect` serves protobuf services over the **Connect** and
**gRPC-Web** protocols, on the port `Bun.serve` already has and through the
middleware chain the app already has. An RPC is rate limited, request logged,
CORS-handled and guarded the same way a route is.

Native gRPC is not served. It carries `grpc-status` in an HTTP trailer, and
`Bun.serve` sends no trailers, so a gRPC client would read every call as a
protocol error. A request arriving with `content-type: application/grpc` gets a
415 whose body says so. Reaching an existing gRPC fleet needs a proxy such as
Envoy in front, or a separate `node:http2` server outside dunx.

## Install

The Connect packages are optional peers, and the protobuf toolchain is yours:

```bash
bun add @connectrpc/connect @bufbuild/protobuf
```

Generate the service descriptor with `buf` as you would for any Connect server.
dunx reads no `.proto` file and ships no codec.

```proto
syntax = "proto3";
package greet.v1;

message SayRequest { string name = 1; }
message SayResponse { string text = 1; }

service GreetService {
  rpc Say(SayRequest) returns (SayResponse) {}
  rpc Countdown(SayRequest) returns (stream SayResponse) {}
}
```

## The implementation is a provider

One method per RPC, named as `protoc-gen-es` names them: `Say` becomes `say`.
Constructor injection with no annotation, exactly like a controller.

```ts
import { Logger } from '@dunx/core';
import { Code, ConnectError } from '@connectrpc/connect';
import type { SayRequest, SayResponse } from './greet_pb.js';

export class GreetRpc {
  constructor(
    private readonly greetings: Greetings,
    private readonly logger: Logger,
  ) {}

  say(request: SayRequest): Partial<SayResponse> {
    if (request.name === '') {
      throw new ConnectError('name is required', Code.InvalidArgument);
    }
    return { text: `Hello ${request.name}` };
  }

  async *countdown(request: SayRequest): AsyncGenerator<Partial<SayResponse>> {
    for (let i = 3; i > 0; i -= 1) yield { text: `${request.name} ${i}` };
  }
}
```

A thrown `ConnectError` reaches the client as its status code. Anything else
becomes `internal` with no detail leaked.

There are no parameter decorators, so there is no `@Payload()` or `@Ctx()`: a
method takes the request, and Connect's `HandlerContext` is the optional second
argument when one wants headers or the abort signal.

## Binding the module

```ts
import { ConnectModule, connectService } from '@dunx/http/connect';
import { GreetService } from './greet_pb.js';

@Module({
  imports: [
    GreetingsModule,
    ConnectModule.forRoot({
      services: [connectService(GreetService, GreetRpc)],
      imports: [GreetingsModule],
    }),
  ],
})
export class RpcModule {}
```

`connectService` pairs the descriptor with the class and checks the pairing at
compile time, so a renamed RPC or a wrong argument type fails the build instead
of answering `unimplemented`.

`ConnectModule` is its own scope and constructs the implementation classes in it,
so its `imports` names whatever they inject. Importing a module alongside does
not reach them.

`forRootAsync` takes the services first and the rest behind a factory, since the
classes have to be providers before any factory runs:

```ts
ConnectModule.forRootAsync([connectService(GreetService, GreetRpc)], {
  imports: [GreetingsModule],
  useFactory: (config: AppConfigService) => ({
    prefix: config.get('rpcPrefix'),
  }),
  inject: [AppConfigService],
});
```

## Registering the middleware

The module binds `ConnectMiddleware` and does not register it. Position in the
chain decides what covers an RPC:

```ts
const app = await HttpFactory.create(AppModule);
app.use(ThrottleGuard);
app.use(ConnectMiddleware);
```

A guard registered before it covers every RPC. One registered after it does not.

RPC paths are in no route table, so they reach the unmatched-path fallback, where
the middleware claims the ones it serves and lets everything else through to the
usual 404.

## Calling it

Every RPC answers at `/{package}.{Service}/{Method}`. `prefix` moves them;
`setGlobalPrefix` does not, because that prefixes discovered routes.

```ts
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';

const client = createClient(GreetService, createConnectTransport({ baseUrl }));
await client.say({ name: 'world' });
```

dunx wraps no client: the outbound half is the library's own one-liner, and
`createGrpcWebTransport` swaps the protocol without touching the calls.

The Connect protocol is a plain POST, so anything that speaks HTTP can call it
without a generated client:

```bash
curl -X POST -H 'content-type: application/json' \
  -d '{"name":"world"}' http://localhost:3000/greet.v1.GreetService/Say
```

## What is served

| Capability                           | State                                     |
| ------------------------------------ | ----------------------------------------- |
| Connect, unary and server streaming  | Served                                    |
| gRPC-Web, unary and server streaming | Served                                    |
| Client and bidi streaming            | Connect's, over HTTP/2 (`http2: true`)    |
| Native gRPC                          | Not served: `Bun.serve` sends no trailers |
| `.proto` loading and codegen         | Yours, through `buf`                      |

`ConnectRegistry` lists what is mounted, which is what a health page or a test
reads:

```ts
app.get(ConnectRegistry).methods;
// [{ path: '/greet.v1.GreetService/Say', service: 'greet.v1.GreetService',
//    method: 'Say', kind: 'unary', protocols: ['grpc-web', 'connect'] }, ...]
```

On shutdown the registry aborts the signal every running handler holds, so a
long-running implementation gets its cue to wrap up.

Every other `createConnectRouter` option passes through: `interceptors`,
`contextValues`, `requestGate`, `readMaxBytes`, `jsonOptions` and the rest.
`grpc` is the one that does not, and `connect: false` or `grpcWeb: false` turns
either protocol off.

`examples/full/src/rpc` is a working version of all of this.
