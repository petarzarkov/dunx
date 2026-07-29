import { describe, expect, it } from 'bun:test';
import { Backend, Dialect } from '../contract.js';
import { DatabaseError } from '../errors.js';
import { dialectFromUrl, SqlOptions } from './options.js';

describe('dialectFromUrl', () => {
  it.each([
    ['postgres://user:pw@localhost:5432/app', Dialect.POSTGRES],
    ['postgresql://user:pw@localhost:5432/app', Dialect.POSTGRES],
    ['mysql://user:pw@localhost:3306/app', Dialect.MYSQL],
    ['mariadb://user:pw@localhost:3306/app', Dialect.MARIADB],
    ['sqlite://:memory:', Dialect.SQLITE],
    ['file:./dev.db', Dialect.SQLITE],
    ['POSTGRES://localhost/app', Dialect.POSTGRES],
  ])('reads %p as %p', (url, dialect) => {
    expect(dialectFromUrl(url)).toBe(dialect);
  });

  it('accepts a URL object', () => {
    expect(dialectFromUrl(new URL('postgres://localhost:5432/app'))).toBe(
      Dialect.POSTGRES,
    );
  });

  /** Bun's own rejection message lists exactly four adapters; pg:// is not one. */
  it('rejects pg://, which Bun does not support either', () => {
    expect(() => dialectFromUrl('pg://localhost/app')).toThrow(DatabaseError);
    expect(() => dialectFromUrl('pg://localhost/app')).toThrow(/pg:\/\//);
  });

  it.each(['oracle://localhost/app', 'mssql://localhost/app', 'redis://x'])(
    'rejects the unsupported scheme in %p',
    (url) => {
      expect(() => dialectFromUrl(url)).toThrow(DatabaseError);
    },
  );

  /**
   * Bun reads a schemeless string as a Postgres *host* — `{ url: './dev.db' }`
   * reports `adapter: 'postgres'` and then fails at connect time with a socket
   * error. Rejecting it here turns that into a message about the URL.
   */
  it.each(['./dev.db', ':memory:', 'localhost', ''])(
    'rejects %p rather than silently treating it as a Postgres host',
    (url) => {
      expect(() => dialectFromUrl(url)).toThrow(DatabaseError);
    },
  );
});

describe('SqlOptions', () => {
  it('derives the dialect at construction, before any I/O', () => {
    const options = new SqlOptions({ url: 'postgres://localhost:5432/app' });
    expect(options.backend).toBe(Backend.SQL);
    expect(options.dialect).toBe(Dialect.POSTGRES);
    expect(options.url).toBe('postgres://localhost:5432/app');
  });

  it('normalises a URL object to its href', () => {
    expect(
      new SqlOptions({ url: new URL('mysql://localhost:3306/app') }).url,
    ).toBe('mysql://localhost:3306/app');
  });

  it('fails on a bad URL at construction, not at connect', () => {
    expect(() => new SqlOptions({ url: 'pg://localhost/app' })).toThrow(
      DatabaseError,
    );
  });

  it('passes driver options through with the normalised url', () => {
    const options = new SqlOptions({
      url: new URL('postgres://localhost:5432/app'),
      max: 4,
      idleTimeout: 30,
      connectionTimeout: 5,
      prepare: false,
      bigint: true,
    });

    expect(options.toDriverOptions()).toEqual({
      url: 'postgres://localhost:5432/app',
      max: 4,
      idleTimeout: 30,
      connectionTimeout: 5,
      prepare: false,
      bigint: true,
    });
  });

  it('is what Bun.SQL actually accepts', () => {
    // Construction is lazy — this asserts the option shape without connecting.
    const options = new SqlOptions({
      url: 'postgres://localhost:5432/app',
      max: 2,
    });
    const client = new Bun.SQL(options.toDriverOptions());
    expect(client.options.adapter).toBe(Dialect.POSTGRES);
  });
});
