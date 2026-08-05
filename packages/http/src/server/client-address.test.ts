import { describe, expect, test } from 'bun:test';
import { inject, Module, provide } from '@dunx/core';
import type { BunRequest } from 'bun';
import { Controller, Get } from '../route/decorators.js';
import { ClientAddress } from './client-address.js';
import type { RouteContext } from './context.js';
import { HttpFactory } from './factory.js';
import type { Middleware, Next } from './middleware.js';

/**
 * `ClientAddress` is a framework service like `PubSub`: `listen()` hands it the live
 * server, and `app.clientIp(req)` is documented as the same instance a middleware
 * injects. Under module scoping an unbound class self-binds into **the scope that
 * asked**, so two modules injecting it used to get two instances - one of which the
 * server was never attached to, and `app.get` could not say which the app meant.
 */
@Controller('where')
class WhereController {
  // The field-initializer form, which resolves from this controller's own module
  // scope - so it is the same lookup a constructor parameter would make.
  readonly address = inject(ClientAddress);

  @Get('/')
  from(input: { req: BunRequest }): { ip: string | undefined } {
    return { ip: this.address.of(input.req) };
  }
}

class AddressGuard implements Middleware {
  constructor(readonly address: ClientAddress) {}

  handle(req: BunRequest, _ctx: RouteContext, next: Next): Promise<Response> {
    this.address.of(req);
    return next();
  }
}

// Written out because this package's tests run without @dunx/transform, which is
// what the missing-plugin test in core asserts.
const fromAddress = <T>(build: (address: ClientAddress) => T) =>
  ({ useFactory: build, inject: [ClientAddress] as const }) as const;

describe('ClientAddress', () => {
  test('is one instance across modules, and the server reaches it', async () => {
    @Module({
      providers: [
        provide(
          AddressGuard,
          fromAddress((a) => new AddressGuard(a)),
        ),
      ],
      exports: [AddressGuard],
    })
    class GuardModule {}

    @Module({ imports: [GuardModule], controllers: [WhereController] })
    class Root {}

    const app = await HttpFactory.create(Root, {
      middleware: [AddressGuard],
      requestLogging: false,
    });
    // Two different scopes injected it. Before the fix this threw
    // "ClientAddress is declared by ... and ...", because each had self-bound.
    expect(app.get(ClientAddress)).toBe(app.get(AddressGuard).address);

    const url = await app.listen(0);
    const response = await fetch(`${url}where`);

    // A 200 with an address, rather than the 500 an unattached instance gives:
    // `of()` throws "ClientAddress has no server yet" when `listen()` handed the
    // server to some other instance.
    //
    // Deliberately not asserting the literal. Loopback is `127.0.0.1`, `::1` or
    // `::ffff:127.0.0.1` depending on how the host resolves `localhost` and whether
    // it is dual-stack - which is what this test got wrong first, passing on WSL and
    // failing on a GitHub runner. Which instance answered is the subject; what the
    // kernel called the peer is not.
    expect(response.status).toBe(200);

    await app.shutdown();
  });
});
