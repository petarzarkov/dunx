import { describe, expect, it } from 'bun:test';
import { assertUrl, redactUrl, type UrlProblem } from './url.js';

const capture = (url: string): UrlProblem | undefined => {
  let seen: UrlProblem | undefined;
  try {
    assertUrl(url, ['redis:', 'rediss:'], (problem) => {
      seen = problem;
      return new Error('refused');
    });
  } catch {
    return seen;
  }
  return undefined;
};

describe('redactUrl', () => {
  it('replaces the password and keeps the user', () => {
    expect(redactUrl('redis://app:hunter2@host:6379')).toBe(
      'redis://app:***@host:6379',
    );
  });

  it('leaves a url without a password as it was', () => {
    expect(redactUrl('redis://host:6379')).toBe('redis://host:6379');
  });
});

describe('assertUrl', () => {
  it('returns a url whose scheme is allowed', () => {
    expect(
      assertUrl('rediss://host:6380', ['rediss:'], () => new Error()),
    ).toBe('rediss://host:6380');
  });

  it('reports an unparseable url without the url', () => {
    expect(capture('::hunter2::')).toEqual({ kind: 'invalid' });
  });

  it('reports a wrong scheme with the password redacted', () => {
    expect(capture('http://app:hunter2@host:6379')).toEqual({
      kind: 'protocol',
      protocol: 'http:',
      redacted: 'http://app:***@host:6379/',
    });
  });

  it('throws the error fail built', () => {
    const error = new TypeError('mine');
    expect(() => assertUrl('nope', [], () => error)).toThrow(error);
  });
});
