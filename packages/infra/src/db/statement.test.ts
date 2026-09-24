import { describe, expect, it } from 'bun:test';
import { sanitize, summarise } from './statement.js';

describe('summarise', () => {
  it('names the table a write leads with, quoted or not', () => {
    expect(summarise('insert into "users" ("id") values ($1)')).toEqual({
      operation: 'INSERT',
      target: 'users',
    });
    expect(summarise('UPDATE `shop`.`orders` SET a = ?')).toEqual({
      operation: 'UPDATE',
      target: 'shop.orders',
    });
    expect(summarise('  delete from t where id = ?')).toEqual({
      operation: 'DELETE',
      target: 't',
    });
  });

  it('names a select table only when it has one from and no join', () => {
    expect(summarise('select "id" from "users" where "id" = $1')).toEqual({
      operation: 'SELECT',
      target: 'users',
    });
    expect(summarise('select (select count(*) from b) from a')).toEqual({
      operation: 'SELECT',
    });
    expect(summarise('select * from a join b on a.id = b.id')).toEqual({
      operation: 'SELECT',
    });
    expect(summarise('select 1')).toEqual({ operation: 'SELECT' });
  });

  it('does not guess at a CTE or at text with no keyword', () => {
    expect(summarise('with r as (select 1) select * from r')).toEqual({});
    expect(summarise('-- nothing')).toEqual({});
    expect(summarise('pragma table_info(t)')).toEqual({ operation: 'PRAGMA' });
  });
});

describe('sanitize', () => {
  it('replaces literals and keeps placeholders', () => {
    expect(
      sanitize("select * from t where a = 'x''y' and b = 42 and c = $1"),
    ).toBe("select * from t where a = '?' and b = ? and c = $1");
  });
});
