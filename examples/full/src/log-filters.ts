import type { LogFilter } from '@dunx/infra/logger';

/**
 * A mailbox, then a domain ending in a letters-only TLD, so `v2@3.1` and
 * `lodash@4.17.21` are not addresses. `u` makes `\p{L}` reach `josé`. One
 * instance is safe to share: `replace` resets `lastIndex` on a `g` pattern.
 */
const EMAIL = /[\p{L}\p{N}._%+-]+@((?:[\p{L}\p{N}-]+\.)+\p{L}{2,})/gu;

/**
 * `message` is reserved, so no serializer reaches it, and `maskFields` matches
 * keys, not text. A filter sees the whole entry: this one keeps an address's
 * domain and hides the mailbox, on the way to every transport.
 */
export const maskEmails: LogFilter = (entry) => {
  const message = entry['message'];
  return typeof message === 'string' && message.includes('@')
    ? { ...entry, message: message.replace(EMAIL, '***@$1') }
    : entry;
};
