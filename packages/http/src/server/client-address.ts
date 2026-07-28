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
 * The client's address, honouring the `'trust proxy'` setting. Every class is
 * injectable, so `inject(ClientAddress)` in a middleware or controller needs no
 * registration; `app.clientIp(req)` is the same instance.
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
