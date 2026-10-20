import { describe, expect, test } from 'bun:test';
import { pathnameOf, searchOf } from './url.js';

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

describe('searchOf', () => {
  test('returns the query string without the leading question mark', () => {
    expect(searchOf('http://localhost/users?page=2&sort=asc')).toBe(
      'page=2&sort=asc',
    );
  });

  test('returns an empty string when there is no query', () => {
    expect(searchOf('http://localhost/users')).toBe('');
  });

  test('strips a fragment', () => {
    expect(searchOf('http://localhost/users?page=2#top')).toBe('page=2');
  });
});
