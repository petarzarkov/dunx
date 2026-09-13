import { describe, expect, it } from 'bun:test';
import {
  everyRecipient,
  formatAddress,
  toAddress,
  toAddressList,
} from './message.js';
import { outbound } from './outbound.fixture.js';

describe('toAddress', () => {
  it('wraps a bare address', () => {
    expect(toAddress('a@example.com')).toEqual({ address: 'a@example.com' });
  });

  it('passes an object through', () => {
    const address = { address: 'a@example.com', name: 'A' };
    expect(toAddress(address)).toBe(address);
  });
});

describe('toAddressList', () => {
  it('is empty for undefined', () => {
    expect(toAddressList(undefined)).toEqual([]);
  });

  it('wraps a single recipient', () => {
    expect(toAddressList('a@example.com')).toEqual([
      { address: 'a@example.com' },
    ]);
  });

  it('maps an array', () => {
    expect(
      toAddressList(['a@example.com', { address: 'b@example.com' }]),
    ).toEqual([{ address: 'a@example.com' }, { address: 'b@example.com' }]);
  });
});

describe('formatAddress', () => {
  it('is the bare address with no name', () => {
    expect(formatAddress('a@example.com')).toBe('a@example.com');
  });

  it('is the bare address for an empty name', () => {
    expect(formatAddress({ address: 'a@example.com', name: '' })).toBe(
      'a@example.com',
    );
  });

  it('quotes a name', () => {
    expect(formatAddress({ address: 'a@example.com', name: 'A Person' })).toBe(
      '"A Person" <a@example.com>',
    );
  });

  // A name is attacker-supplied often enough: an unescaped quote closes the
  // quoted string and everything after it becomes header syntax.
  it('escapes quotes and backslashes in a name', () => {
    expect(
      formatAddress({
        address: 'a@example.com',
        name: 'X" <evil@example.com>, "Y\\Z',
      }),
    ).toBe('"X\\" <evil@example.com>, \\"Y\\\\Z" <a@example.com>');
  });
});

describe('everyRecipient', () => {
  it('spans to, cc and bcc', () => {
    const message = outbound({
      to: [{ address: 'to@example.com' }],
      cc: [{ address: 'cc@example.com' }],
      bcc: [{ address: 'bcc@example.com' }],
    });
    expect(everyRecipient(message)).toEqual([
      'to@example.com',
      'cc@example.com',
      'bcc@example.com',
    ]);
  });
});
