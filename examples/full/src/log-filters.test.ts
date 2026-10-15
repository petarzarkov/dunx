import { describe, expect, it } from 'bun:test';
import { maskEmails } from './log-filters.js';

const masked = (message: string): unknown =>
  maskEmails({ message }, 'info')?.['message'];

describe('maskEmails', () => {
  it('hides the mailbox and keeps the domain', () => {
    expect(masked('sent to ada@example.com')).toBe('sent to ***@example.com');
    expect(masked('cc a.b+c@mail.co.uk.')).toBe('cc ***@mail.co.uk.');
  });

  it('masks a mailbox outside ASCII', () => {
    expect(masked('from josé@exämple.de')).toBe('from ***@exämple.de');
  });

  it('leaves text that only looks like one alone', () => {
    for (const text of [
      'deploy tag v2@3.1 failed',
      'installed lodash@4.17.21',
      'cc @release.bot',
      '@dunx/core@3.10.3 loaded',
    ]) {
      expect(masked(text)).toBe(text);
    }
  });

  it('masks every address, not just the first, on repeated calls', () => {
    const line = 'a@x.io and b@y.io';
    expect(masked(line)).toBe('***@x.io and ***@y.io');
    expect(masked(line)).toBe('***@x.io and ***@y.io');
  });
});
