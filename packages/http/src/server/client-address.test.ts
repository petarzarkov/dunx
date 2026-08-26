import { describe, expect, test } from 'bun:test';
import { inject, Module, provide } from '@dunx/core';
import type { BunRequest, Server } from 'bun';
import { Controller, Get } from '../route/decorators.js';
import { attachAddressSource, ClientAddress } from './client-address.js';
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

const SOCKET = '10.0.0.254';

/**
 * A `ClientAddress` with no server behind it, so the hop arithmetic is the only
 * thing under test. `requestIP` answers a fixed peer, which stands in for the
 * proxy that opened the connection.
 */
const attached = (
  trustProxy: boolean | number,
  socket: string = SOCKET,
): ClientAddress => {
  const address = new ClientAddress();
  attachAddressSource(address, {
    server: {
      requestIP: () => ({ address: socket }),
    } as unknown as Server<unknown>,
    trustProxy,
  });
  return address;
};

const withForwarded = (value?: string): BunRequest =>
  new Request(
    'http://test/x',
    value === undefined ? undefined : { headers: { 'x-forwarded-for': value } },
  ) as BunRequest;

/**
 * `X-Forwarded-For` is appended to, so the entry a proxy adds is the peer it saw.
 * The leftmost entry is whatever the original caller sent, which a caller may
 * invent. Counting from the right is what makes the header worth reading: with one
 * trusted proxy, only the last entry was written by something under our control.
 */
describe('ClientAddress hop counting', () => {
  test('a forged leftmost entry does not win behind one proxy', () => {
    // The attack: a client sends its own header, the proxy appends the address it
    // actually saw. Reading `[0]` returns the forgery.
    const req = withForwarded('1.2.3.4, 203.0.113.9');
    expect(attached(true).of(req)).toBe('203.0.113.9');
    expect(attached(true).of(req)).not.toBe('1.2.3.4');
  });

  test('one trusted hop reads the last entry', () => {
    expect(attached(true).of(withForwarded('203.0.113.9'))).toBe('203.0.113.9');
    expect(attached(1).of(withForwarded('203.0.113.9'))).toBe('203.0.113.9');
  });

  test('a hop count reaches past that many proxies', () => {
    const req = withForwarded('203.0.113.9, 10.1.1.1, 10.1.1.2');
    expect(attached(1).of(req)).toBe('10.1.1.2');
    expect(attached(2).of(req)).toBe('10.1.1.1');
    expect(attached(3).of(req)).toBe('203.0.113.9');
  });

  test('a count longer than the header stops at the leftmost entry', () => {
    expect(attached(9).of(withForwarded('203.0.113.9, 10.1.1.1'))).toBe(
      '203.0.113.9',
    );
  });

  test('the header is ignored entirely when the setting is off', () => {
    const req = withForwarded('1.2.3.4');
    expect(attached(false).of(req)).toBe(SOCKET);
    expect(attached(0).of(req)).toBe(SOCKET);
  });

  test('falls back to the socket when the header is absent or empty', () => {
    expect(attached(true).of(withForwarded())).toBe(SOCKET);
    expect(attached(true).of(withForwarded('   '))).toBe(SOCKET);
    expect(attached(true).of(withForwarded(' , ,'))).toBe(SOCKET);
  });

  test('blank entries are dropped rather than counted as a hop', () => {
    expect(attached(1).of(withForwarded('203.0.113.9, , 10.1.1.1'))).toBe(
      '10.1.1.1',
    );
    expect(attached(2).of(withForwarded('203.0.113.9, , 10.1.1.1'))).toBe(
      '203.0.113.9',
    );
  });
});

/**
 * Reported from a production migration: on a dual-stack listener the socket
 * answers `::ffff:10.0.0.1`, an app storing plain IPv4 normalised it at one call
 * site and not another, and the second silently matched nothing. It is the same
 * address in a different notation, so `of()` returns one notation.
 */
describe('ClientAddress IPv4-mapped addresses', () => {
  test('the socket form comes back as plain IPv4', () => {
    expect(attached(false, '::ffff:10.0.0.1').of(withForwarded())).toBe(
      '10.0.0.1',
    );
  });

  test('a mapped entry in the header comes back the same way', () => {
    expect(attached(true).of(withForwarded('::ffff:203.0.113.9'))).toBe(
      '203.0.113.9',
    );
    expect(
      attached(2).of(withForwarded('::ffff:203.0.113.9, 10.1.1.1, 10.1.1.2')),
    ).toBe('10.1.1.1');
  });

  test('a real IPv6 address is left alone', () => {
    expect(attached(false, '2001:db8::1').of(withForwarded())).toBe(
      '2001:db8::1',
    );
    expect(attached(false, '::1').of(withForwarded())).toBe('::1');
    expect(attached(true).of(withForwarded('2001:db8::1'))).toBe('2001:db8::1');
  });

  /** The same value in hex. Nothing writes it, so nothing reads it - see `unmap`. */
  test('the hex spelling of a mapped address is not rewritten', () => {
    expect(attached(false, '::ffff:a00:1').of(withForwarded())).toBe(
      '::ffff:a00:1',
    );
  });

  test('a plain IPv4 address is unchanged', () => {
    expect(attached(false, '10.0.0.1').of(withForwarded())).toBe('10.0.0.1');
    expect(attached(true).of(withForwarded('203.0.113.9'))).toBe('203.0.113.9');
  });
});
