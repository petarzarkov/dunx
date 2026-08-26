import { describe, expect, it } from 'bun:test';
import { ConfigError, ConfigService } from './service.js';

/**
 * `ConfigModule` is covered by `module.test.ts`. This is the service on its own,
 * which is what a `validate` function's return value is handed to.
 */
interface AppConfig {
  port: number;
  host: string;
  optional?: string;
  nullable: string | null;
}

const service = (): ConfigService<AppConfig> =>
  new ConfigService<AppConfig>({
    port: 3000,
    host: 'localhost',
    nullable: null,
  });

describe('ConfigService', () => {
  it('exposes the whole validated object for destructuring', () => {
    expect(service().values).toEqual({
      port: 3000,
      host: 'localhost',
      nullable: null,
    });
  });

  it('reads one key', () => {
    expect(service().get('port')).toBe(3000);
    expect(service().get('host')).toBe('localhost');
  });

  it('reads an absent optional key as undefined rather than throwing', () => {
    expect(service().get('optional')).toBeUndefined();
  });

  describe('getOrThrow', () => {
    it('returns a present value', () => {
      expect(service().getOrThrow('host')).toBe('localhost');
    });

    /** Guards the value being present, not the key being declared. */
    it('throws a ConfigError naming the key when the value is undefined', () => {
      expect(() => service().getOrThrow('optional')).toThrow(ConfigError);
      expect(() => service().getOrThrow('optional')).toThrow(
        'Config key "optional" is not set',
      );
    });

    it('treats null as not set, the same as undefined', () => {
      expect(() => service().getOrThrow('nullable')).toThrow(
        'Config key "nullable" is not set',
      );
    });

    it('returns a falsy value that is set, rather than calling it missing', () => {
      const zero = new ConfigService<{ retries: number; name: string }>({
        retries: 0,
        name: '',
      });

      expect(zero.getOrThrow('retries')).toBe(0);
      expect(zero.getOrThrow('name')).toBe('');
    });
  });

  it('names ConfigError so a catch can tell it apart', () => {
    expect(new ConfigError('nope').name).toBe('ConfigError');
  });
});

/**
 * Dotted paths. Typed by an overload per depth rather than a recursive
 * conditional, for the reason recorded above `get` - the types are checked by
 * `bun run typecheck`, so what is left to assert here is the walk.
 */
interface Nested {
  port: number;
  db: { host: string; pool: { max: number }; label?: string };
  cache?: { ttl: number };
  'has.dot': string;
  empty: null;
}

const nested = (): ConfigService<Nested> =>
  new ConfigService<Nested>({
    port: 3000,
    db: { host: 'localhost', pool: { max: 10 } },
    'has.dot': 'read whole',
    empty: null,
  });

describe('dotted paths', () => {
  it('reads two and three segments deep', () => {
    expect(nested().get('db.host')).toBe('localhost');
    expect(nested().get('db.pool.max')).toBe(10);
  });

  it('still reads a top-level key, including the object itself', () => {
    expect(nested().get('port')).toBe(3000);
    expect(nested().get('db')).toEqual({
      host: 'localhost',
      pool: { max: 10 },
    });
  });

  it('reads through an absent step as undefined rather than throwing', () => {
    expect(nested().get('cache.ttl')).toBeUndefined();
    expect(nested().get('db.label')).toBeUndefined();
  });

  it('reads through a null step as undefined rather than throwing', () => {
    // `empty` is null, so the walk stops there. Reaching into it would be a
    // TypeError, which is what a hand-written `values.empty.anything` gives.
    expect(nested().get('empty')).toBeNull();
  });

  /**
   * A top-level key that contains a dot is read whole. Checked before the walk,
   * so a real key always beats a path that happens to spell one - and so every
   * call written before paths existed reads exactly what it used to.
   */
  it('prefers a literal key over splitting it', () => {
    expect(nested().get('has.dot')).toBe('read whole');
  });

  describe('getOrThrow', () => {
    it('takes the same paths', () => {
      expect(nested().getOrThrow('db.pool.max')).toBe(10);
      expect(nested().getOrThrow('db.host')).toBe('localhost');
    });

    it('names the whole path when a step is missing', () => {
      expect(() => nested().getOrThrow('cache.ttl')).toThrow(ConfigError);
      expect(() => nested().getOrThrow('cache.ttl')).toThrow(
        'Config key "cache.ttl" is not set',
      );
    });
  });
});
