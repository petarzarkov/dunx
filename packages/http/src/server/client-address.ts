import type { BunRequest, Server } from 'bun';
import { AppError } from '@dunx/core';

interface AddressSource {
  readonly server: Server<unknown>;
  readonly trustProxy: boolean | number;
}

/**
 * How many entries at the right-hand end of `X-Forwarded-For` were written by a
 * proxy under our control. `true` is one, which is the single-proxy deployment.
 */
const trustedHops = (setting: boolean | number): number => {
  if (setting === true) return 1;
  if (setting === false) return 0;
  return Number.isFinite(setting) ? Math.max(0, Math.trunc(setting)) : 0;
};

// Kept off the class so `ClientAddress`'s public shape stays `of(req)`. Per
// instance rather than module-level, because two apps in one process (every test
// file) must not share a server.
const sources = new WeakMap<ClientAddress, AddressSource>();

/**
 * The client's address, honouring `'trust proxy'`. The address is counted from the
 * right of `X-Forwarded-For` by the number of trusted hops, never from the left: a
 * client can send anything, and only the entries a proxy appended carry weight.
 *
 * Bound by `HttpFactory`'s global wrapper, which is not optional under module
 * scoping - an unbound class self-binds into whichever scope asks first, so a
 * second module injecting it was a boot error.
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

    const hops = trustedHops(source.trustProxy);
    if (hops > 0) {
      const entries = (req.headers.get('x-forwarded-for') ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      // Each proxy appends the peer it saw, so the last entry is the only one a
      // single trusted proxy wrote. Reading `[0]` returned whatever the caller
      // sent, which a caller may invent. A count longer than the header clamps
      // to the leftmost entry rather than reaching past it.
      const entry = entries[Math.max(0, entries.length - hops)];
      if (entry) return entry;
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
