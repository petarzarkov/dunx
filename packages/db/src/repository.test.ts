import { beforeEach, describe, expect, it } from 'bun:test';
import { Dialect, type Database } from './contract.js';
import { DatabaseError } from './errors.js';
import { quoteIdentifier, Repository } from './repository.js';
import { SqliteOptions } from './sqlite/options.js';

describe('quoteIdentifier', () => {
  it.each([
    [Dialect.POSTGRES, 'users', '"users"'],
    [Dialect.SQLITE, 'users', '"users"'],
    [Dialect.MYSQL, 'users', '`users`'],
    [Dialect.MARIADB, 'users', '`users`'],
  ])('quotes for %p', (dialect, identifier, expected) => {
    expect(quoteIdentifier(dialect, identifier)).toBe(expected);
  });

  it('doubles an embedded quote so it cannot close the identifier', () => {
    expect(quoteIdentifier(Dialect.POSTGRES, 'we"ird')).toBe('"we""ird"');
    expect(quoteIdentifier(Dialect.MYSQL, 'we`ird')).toBe('`we``ird`');
  });

  it('quotes a name that would otherwise need it', () => {
    expect(quoteIdentifier(Dialect.POSTGRES, 'select')).toBe('"select"');
    expect(quoteIdentifier(Dialect.POSTGRES, 'a b')).toBe('"a b"');
  });

  it.each(['', '\0', 'a\0b'])('rejects %p', (identifier) => {
    expect(() => quoteIdentifier(Dialect.SQLITE, identifier)).toThrow(
      DatabaseError,
    );
  });
});

/** A subclass that declares no constructor of its own — the point of the base. */
class UsersRepository extends Repository {
  async names(): Promise<readonly string[]> {
    const rows = await this.db.all<{ name: string }>(
      `SELECT name FROM ${this.table('users')} ORDER BY name`,
    );
    return rows.map((row) => row.name);
  }
}

describe('Repository', () => {
  let db: Database;

  beforeEach(async () => {
    db = await new SqliteOptions().open();
    await db.exec('CREATE TABLE users (name TEXT)');
    await db.run('INSERT INTO users (name) VALUES (?), (?)', ['ada', 'grace']);
  });

  it('exposes the database to a subclass through its inherited constructor', async () => {
    expect(await new UsersRepository(db).names()).toEqual(['ada', 'grace']);
  });

  it('quotes identifiers for the connected dialect', async () => {
    class Probe extends Repository {
      quoted(): string {
        return this.table('users');
      }
    }
    expect(new Probe(db).quoted()).toBe('"users"');
  });

  /**
   * The container reads dependencies along the prototype chain, which is the
   * whole mechanism: a subclass declaring no constructor resolves `Database` from
   * the record the compiler wrote on `Repository`.
   *
   * Its own `length` is 0, because an implicit derived constructor is
   * `(...args) => super(...args)`. That is also why the container's "the plugin
   * never saw this class" arity check stays quiet here rather than misfiring.
   */
  it('inherits its dependencies rather than declaring them', () => {
    expect(Object.getPrototypeOf(UsersRepository)).toBe(Repository);
    expect(UsersRepository.length).toBe(0);
    expect(Repository.length).toBe(1);
  });
});
