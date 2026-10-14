import { describe, expect, test } from 'bun:test';
import { pathnameOf } from './url.js';

describe('pathnameOf', () => {
  test('returns the path of an absolute URL', () => {
    expect(pathnameOf('http://localhost/users')).toBe('/users');
    expect(pathnameOf('https://example.com/a/b')).toBe('/a/b');
  });

  test('stops at the query string', () => {
    expect(pathnameOf('http://localhost/users?page=2')).toBe('/users');
  });

  test('returns the root path when there is no path', () => {
    expect(pathnameOf('http://localhost')).toBe('/');
    expect(pathnameOf('http://localhost?x=1')).toBe('/');
  });

  test('keeps a trailing slash and path segments intact', () => {
    expect(pathnameOf('http://localhost/')).toBe('/');
    expect(pathnameOf('http://localhost/users/')).toBe('/users/');
  });
});
