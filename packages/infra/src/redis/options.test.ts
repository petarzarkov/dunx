import { describe, expect, it } from 'bun:test';
import { RedisError, RedisErrorCode } from './errors.js';
import { defaultRedisUrl, REDIS_PROTOCOLS, RedisOptions } from './options.js';

const withEnv = <T>(
  vars: Record<string, string | undefined>,
  run: () => T,
): T => {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

describe('RedisOptions url', () => {
  it('falls back through VALKEY_URL, REDIS_URL, then localhost', () => {
    expect(
      withEnv({ VALKEY_URL: 'valkey://v:1', REDIS_URL: 'redis://r:2' }, () =>
        defaultRedisUrl(),
      ),
    ).toBe('valkey://v:1');
    expect(
      withEnv({ VALKEY_URL: undefined, REDIS_URL: 'redis://r:2' }, () =>
        defaultRedisUrl(),
      ),
    ).toBe('redis://r:2');
    expect(
      withEnv({ VALKEY_URL: undefined, REDIS_URL: undefined }, () =>
        defaultRedisUrl(),
      ),
    ).toBe('valkey://localhost:6379');
  });

  it('uses the default url when none is given', () => {
    const options = withEnv(
      { VALKEY_URL: undefined, REDIS_URL: undefined },
      () => new RedisOptions(),
    );
    expect(options.url).toBe('valkey://localhost:6379');
  });

  it('accepts every protocol the runtime supports', () => {
    for (const protocol of REDIS_PROTOCOLS) {
      const url = `${protocol}//localhost:6379`;
      expect(new RedisOptions({ url }).url).toBe(url);
    }
  });

  // Bun takes an unparseable string and only fails later, as an opaque
  // "Connection closed" - this is the check that turns it into a boot error.
  it('rejects an unparseable url up front', () => {
    let thrown: unknown;
    try {
      new RedisOptions({ url: 'not-a-url' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RedisError);
    expect((thrown as RedisError).code).toBe(RedisErrorCode.INVALID_URL);
    expect((thrown as RedisError).message).toContain('not a valid URL');
  });

  it('rejects a url whose protocol is not a redis one', () => {
    let thrown: unknown;
    try {
      new RedisOptions({ url: 'http://localhost:6379' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RedisError);
    expect((thrown as RedisError).code).toBe(RedisErrorCode.INVALID_URL);
    expect((thrown as RedisError).message).toContain('Unsupported protocol');
    expect((thrown as RedisError).message).toContain('redis:');
  });

  it('redacts the password', () => {
    const options = new RedisOptions({
      url: 'redis://admin:s3cret@localhost:6379',
    });
    expect(options.redactedUrl).not.toContain('s3cret');
    expect(options.redactedUrl).toContain('admin');
    expect(options.url).toContain('s3cret');
  });

  it('leaves a url with no password alone', () => {
    const options = new RedisOptions({ url: 'redis://localhost:6379' });
    expect(options.redactedUrl).toBe('redis://localhost:6379');
  });
});

describe('RedisOptions.toClientOptions', () => {
  // Under exactOptionalPropertyTypes an explicit undefined is not an absent key,
  // and Bun only applies its defaults to absent ones.
  it('omits every key the caller did not set', () => {
    const options = new RedisOptions({ url: 'redis://localhost:6379' });
    expect(Object.keys(options.toClientOptions())).toEqual([]);
  });

  it('passes through the ones that were set', () => {
    const options = new RedisOptions({
      url: 'redis://localhost:6379',
      connectionTimeout: 500,
      idleTimeout: 10,
      autoReconnect: false,
      maxRetries: 0,
      enableOfflineQueue: false,
      enableAutoPipelining: false,
      tls: true,
    });
    expect(options.toClientOptions()).toEqual({
      connectionTimeout: 500,
      idleTimeout: 10,
      autoReconnect: false,
      maxRetries: 0,
      enableOfflineQueue: false,
      enableAutoPipelining: false,
      tls: true,
    });
  });

  it('keeps falsy values rather than dropping them', () => {
    const options = new RedisOptions({
      url: 'redis://localhost:6379',
      idleTimeout: 0,
      autoReconnect: false,
    });
    expect(options.toClientOptions()).toEqual({
      idleTimeout: 0,
      autoReconnect: false,
    });
  });

  it('does not leak eager or name into the client options', () => {
    const options = new RedisOptions({
      url: 'redis://localhost:6379',
      name: 'cache',
      eager: true,
    });
    expect(options.name).toBe('cache');
    expect(options.eager).toBe(true);
    expect(Object.keys(options.toClientOptions())).toEqual([]);
  });

  it('defaults eager to false and name to undefined', () => {
    const options = new RedisOptions({ url: 'redis://localhost:6379' });
    expect(options.eager).toBe(false);
    expect(options.name).toBeUndefined();
  });
});
