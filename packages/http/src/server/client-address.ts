import type { BunRequest, Server } from 'bun';
import { AppError } from '@dunx/core';

export interface AddressSource {
  readonly server: Server<unknown>;
  readonly trustProxy: boolean;
}

// Kept off the class so `ClientAddress`'s public shape stays `of(req)`. Per
// instance rather than module-level, because two apps in one process (every test
// file) must not share a server.
const sources = new WeakMap<ClientAddress, AddressSource>();

/**
 * The client's address, honouring the `'trust proxy'` setting.
 *
 * Bound and exported by `HttpFactory`'s global wrapper module, so injecting it in a
 * middleware or controller needs no registration and `app.clientIp(req)` is the same
 * instance. That binding is not optional under module scoping: an unbound class
 * self-binds into whichever scope asks first, so a second module injecting it was a
 * boot error naming the first, and `listen()` could attach the server to an instance
 * nothing else held.
 */
export class ClientAddress {
  of(req: BunRequest): string | undefined {
    const source = sources.get(this);
    if (!source) {
      throw new AppError(
        'ClientAddress has no server yet. The address comes from the live Bun ' +
          'server, so it is only available once listen() has run.',
      );
    }

    if (source.trustProxy) {
      const forwarded = req.headers
        .get('x-forwarded-for')
        ?.split(',')[0]
        ?.trim();
      if (forwarded) return forwarded;
    }
    return source.server.requestIP(req)?.address;
  }
}

/** Internal: `listen()` hands the bound server to the resolved singleton. */
export const attachAddressSource = (
  target: ClientAddress,
  source: AddressSource,
): void => {
  sources.set(target, source);
};
