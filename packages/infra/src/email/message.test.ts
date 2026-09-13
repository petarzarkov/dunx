import { describe, expect, it } from 'bun:test';
import { InvalidAddressError } from './errors.js';
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

  it('keeps an object form', () => {
    expect(toAddress({ address: 'a@example.com', name: 'A' })).toEqual({
      address: 'a@example.com',
      name: 'A',
    });
  });

  // A sender is usually configured as one string, and the whole of it used to
  // land in the address slot.
  it('splits `Name <addr>` into the two halves', () => {
    expect(toAddress('Ops <ops@example.com>')).toEqual({
      address: 'ops@example.com',
      name: 'Ops',
    });
    expect(toAddress('"Ops, Inc" <ops@example.com>')).toEqual({
      address: 'ops@example.com',
      name: 'Ops, Inc',
    });
    expect(toAddress('<ops@example.com>')).toEqual({
      address: 'ops@example.com',
    });
  });

  it('round trips what formatAddress produced', () => {
    const formatted = formatAddress({
      address: 'a@example.com',
      name: 'X" <evil@example.com>',
    });

    expect(toAddress(formatted)).toEqual({
      address: 'a@example.com',
      name: 'X" <evil@example.com>',
    });
  });
});

// Header injection, which escaping cannot fix: there is no rendering of
// `a@x,evil@y` inside one recipient that means what the caller wrote.
describe('toAddress refuses what cannot go in a header', () => {
  it.each([
    ['a@example.com,evil@attacker.com', 'a comma'],
    ['a@example.com;evil@attacker.com', 'a semicolon'],
    ['a@example.com\r\nBcc: evil@attacker.com', 'a CRLF'],
    ['a@example.com\nBcc: evil@attacker.com', 'a bare newline'],
    ['a@example.com\0', 'a NUL'],
    ['a@example.com>', 'a stray angle bracket'],
    ['not-an-address', 'no @'],
    ['', 'nothing at all'],
  ])('refuses %j, which carries %s', (value) => {
    expect(() => toAddress(value)).toThrow(InvalidAddressError);
  });

  it('refuses a newline in the display name', () => {
    expect(() =>
      toAddress({ address: 'a@example.com', name: 'A\r\nBcc: evil@x.com' }),
    ).toThrow(InvalidAddressError);
  });

  it('refuses one through toAddressList, so every field is covered', () => {
    expect(() =>
      toAddressList(['a@example.com', 'b@x.com,c@evil.com']),
    ).toThrow(InvalidAddressError);
  });

  it('carries a 400 and names the value', () => {
    const error = new InvalidAddressError('a@x.com,b@y.com', 'a comma');

    expect(error.status).toBe(400);
    expect(error.name).toBe('InvalidAddressError');
    expect(error.message).toContain('a@x.com,b@y.com');
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
