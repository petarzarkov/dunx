import { describe, expect, it } from 'bun:test';
import type { RunResult } from './contract.js';
import { LazyQuery } from './query.js';

/**
 * The repo's rejection idiom: await the promise, keep the reason. `expect().rejects`
 * is typed as non-thenable by bun:test, which makes the assertion a lint warning.
 */
const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error))
    throw new Error('expected the promise to reject with an Error');
  return error;
};

interface Row {
  id: number;
}

const rows: readonly Row[] = [{ id: 1 }, { id: 2 }];
const result: RunResult = { changes: 2, lastInsertRowid: 7 };

const spy = () => {
  const calls: string[] = [];
  const query = new LazyQuery<Row>({
    all: async () => {
      calls.push('all');
      return rows;
    },
    run: async () => {
      calls.push('run');
      return result;
    },
  });
  return { calls, query };
};

describe('LazyQuery', () => {
  it('sends nothing until a terminal method is called', () => {
    const { calls } = spy();
    expect(calls).toEqual([]);
  });

  it('awaiting it is all(), and only all()', async () => {
    const { calls, query } = spy();
    expect(await query).toEqual(rows);
    expect(calls).toEqual(['all']);
  });

  it('get() takes the first row', async () => {
    const { calls, query } = spy();
    expect(await query.get()).toEqual({ id: 1 });
    expect(calls).toEqual(['all']);
  });

  it('get() is null on an empty result', async () => {
    const query = new LazyQuery<Row>({
      all: async () => [],
      run: async () => result,
    });
    expect(await query.get()).toBe(null);
  });

  it('run() does not fetch rows', async () => {
    const { calls, query } = spy();
    expect(await query.run()).toEqual(result);
    expect(calls).toEqual(['run']);
  });

  it('is thenable, so it composes with Promise combinators', async () => {
    const { query } = spy();
    expect(await Promise.all([query, Promise.resolve('other')])).toEqual([
      rows,
      'other',
    ]);
  });

  it('propagates a rejection through then', async () => {
    const query = new LazyQuery<Row>({
      all: async () => {
        throw new Error('nope');
      },
      run: async () => result,
    });
    expect((await rejection(query.then((value) => value))).message).toBe(
      'nope',
    );
  });
});
