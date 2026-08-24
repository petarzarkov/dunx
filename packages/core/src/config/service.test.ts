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
