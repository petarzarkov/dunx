import { describe, expect, it } from 'bun:test';
import {
  Backend,
  Dialect,
  dialectFromUrl,
  type DialectName,
} from './dialect.js';
import { DatabaseError } from './errors.js';

/** Every scheme, in a form `new URL()` also parses, so both call shapes reuse it. */
const SCHEMES: readonly (readonly [string, DialectName])[] = [
  ['postgres://user:pw@localhost:5432/app', Dialect.POSTGRES],
  ['postgresql://user:pw@localhost:5432/app', Dialect.POSTGRES],
  ['mysql://user:pw@localhost:3306/app', Dialect.MYSQL],
  ['mariadb://user:pw@localhost:3306/app', Dialect.MARIADB],
  ['sqlite:///var/lib/app.db', Dialect.SQLITE],
  ['file:///var/lib/app.db', Dialect.SQLITE],
];

const thrown = (url: string): DatabaseError => {
  try {
    dialectFromUrl(url);
  } catch (error) {
    if (error instanceof DatabaseError) return error;
    throw error;
  }
  throw new Error(`expected ${url} to be rejected`);
};

describe('Dialect', () => {
  it('names the four dialects Bun.SQL accepts', () => {
    expect(Dialect).toEqual({
      POSTGRES: 'postgres',
      MYSQL: 'mysql',
      MARIADB: 'mariadb',
      SQLITE: 'sqlite',
    });
  });

  // as const alone is compile-time only; the freeze is what survives to runtime.
  it('is frozen, not merely readonly', () => {
    expect(Object.isFrozen(Dialect)).toBe(true);
    expect(() => Object.assign(Dialect, { POSTGRES: 'pg' })).toThrow(TypeError);
    expect(Dialect.POSTGRES).toBe('postgres');
  });
});

describe('Backend', () => {
  // `SQLITE` is the one value that is also a dialect name; the SQL backend is
  // Postgres-only and so shares no name with its dialect.
  it('names the two drizzle drivers', () => {
    expect(Backend).toEqual({ SQLITE: 'sqlite', SQL: 'sql' });
    expect(Backend.SQLITE).toBe(Dialect.SQLITE);
    expect(Object.values(Dialect)).not.toContain(Backend.SQL);
  });

  it('is frozen, not merely readonly', () => {
    expect(Object.isFrozen(Backend)).toBe(true);
    expect(() => Object.assign(Backend, { SQL: 'pg' })).toThrow(TypeError);
    expect(Backend.SQL).toBe('sql');
  });
});

describe('dialectFromUrl', () => {
  it.each(SCHEMES)('reads the string %p as %p', (url, dialect) => {
    expect(dialectFromUrl(url)).toBe(dialect);
  });

  it('reads a URL instance of every scheme the same way', () => {
    for (const [url, dialect] of SCHEMES)
      expect(dialectFromUrl(new URL(url))).toBe(dialect);
  });

  // `new URL()` rejects all three, so only the string path can reach them —
  // which is why the function parses the scheme itself rather than using URL.
  it.each(['sqlite://:memory:', 'sqlite:dev.db', 'file:./dev.db'])(
    'reads the unparseable-as-URL sqlite form %p',
    (url) => {
      expect(dialectFromUrl(url)).toBe(Dialect.SQLITE);
    },
  );

  it.each([
    ['POSTGRES://localhost/app', Dialect.POSTGRES],
    ['PostgreSQL://localhost/app', Dialect.POSTGRES],
    ['MariaDB://localhost/app', Dialect.MARIADB],
    ['SQLite://./dev.db', Dialect.SQLITE],
  ])('lowercases the scheme in %p to read %p', (url, dialect) => {
    expect(dialectFromUrl(url)).toBe(dialect);
  });

  /** Bun's own rejection message lists exactly four adapters; pg:// is not one. */
  it('rejects pg://, naming it and listing what it accepts instead', () => {
    const error = thrown('pg://localhost/app');
    expect(error.message).toContain('pg:// is not supported');
    expect(error.message).toContain('pg://localhost/app');
    for (const scheme of [
      'postgres:',
      'postgresql:',
      'mysql:',
      'mariadb:',
      'sqlite:',
      'file:',
    ])
      expect(error.message).toContain(scheme);
  });

  it.each(['oracle://localhost/app', 'mssql://localhost/app'])(
    'rejects the unsupported scheme in %p',
    (url) => {
      expect(() => dialectFromUrl(url)).toThrow(DatabaseError);
    },
  );

  /**
   * Bun reads a schemeless string as a Postgres *host* — `{ url: './dev.db' }`
   * reports `adapter: 'postgres'` and only fails later with a socket error.
   */
  it.each([
    './dev.db',
    ':memory:',
    'localhost',
    // A colon, so a naive "has a scheme" check would let this one through.
    'localhost:5432/app',
    '',
  ])(
    'rejects %p rather than silently treating it as a Postgres host',
    (url) => {
      expect(() => dialectFromUrl(url)).toThrow(DatabaseError);
    },
  );

  it('rejects with a DatabaseError, not a bare Error', () => {
    const error = thrown('pg://localhost/app');
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DatabaseError');
  });
});
