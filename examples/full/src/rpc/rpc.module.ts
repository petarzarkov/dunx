import { Module } from '@dunx/core';
import { ConnectModule, connectService } from '@dunx/http/connect';
import { GreetRpc } from './greet.rpc.js';
import { GreetService } from './greet_pb.js';
import { Greetings } from './greetings.service.js';
import { RpcDemo } from './rpc.demo.js';

/** What the RPC implementation injects. Its own module because `ConnectModule`
 * is a scope of its own and has to import whatever `GreetRpc` asks for. */
@Module({
  providers: [Greetings],
  exports: [Greetings],
})
export class GreetingsModule {}

/**
 * Protobuf services over Connect and gRPC-Web, on the port this app already
 * serves. `main.ts` registers `ConnectMiddleware` last, so an RPC is request
 * logged and CORS-handled like every route. `ThrottleGuard` does not reach it:
 * it skips every unmatched path, and an RPC path is in no route table.
 *
 * `greet_pb.ts` is `buf generate` output, committed. Regenerate it from
 * `greet.proto` with `bun run gen:proto`; dunx loads no `.proto` and ships no
 * codec.
 */
@Module({
  imports: [
    GreetingsModule,
    ConnectModule.forRoot({
      services: [connectService(GreetService, GreetRpc)],
      imports: [GreetingsModule],
    }),
  ],
  providers: [RpcDemo],
  exports: [RpcDemo],
})
export class RpcModule {}
