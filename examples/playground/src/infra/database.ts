import type { OnShutdown } from '@dunx/core';
import type { Config } from '../config.js';

// An abstract class is a runtime value, so it works as an injection token with no
// token() call — and it cannot be constructed, so the container will not try to
// self-bind it. This is the contract-without-an-interface pattern.
export abstract class Database implements OnShutdown {
  abstract query(sql: string): readonly string[];
  abstract onShutdown(): Promise<void>;
}

/** Stands in for a real driver handshake — the reason the factory is async. */
export const connect = async (config: Config): Promise<Database> => {
  await Bun.sleep(5);
  const rows = [`row from ${config.databaseUrl}`];

  return {
    query: (sql) => [...rows, `via ${sql}`],
    onShutdown: async () => {
      await Bun.sleep(5);
      console.log('[dunx] database closed');
    },
  };
};
