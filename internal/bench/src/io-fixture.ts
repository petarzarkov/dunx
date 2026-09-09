/**
 * The Redis key and the Postgres row every `io` subject reads, seeded from the
 * harness so no subject can seed its own and measure a different amount of work.
 *
 * Seeded with `Bun.SQL` and `Bun.RedisClient` because the harness runs on Bun and
 * needs no driver of its own for it.
 *
 * **The scenario is opt-in on the services being there.** `probeIo` connects once
 * before anything is measured; if either service does not answer, the `io`
 * scenario is dropped with a line saying so and the run continues, the same way a
 * missing toolchain drops its subjects.
 */
import { RedisClient, SQL } from 'bun';
import {
  IO_POOL_SIZE,
  IO_REDIS_KEY,
  IO_TABLE,
} from '../servers/io/contract.js';
import type { Scenario } from './types.js';

/**
 * The key and the table come from `servers/io/contract.ts`, which twenty subjects
 * read them from. Declaring a second copy here is the drift that matters most: a
 * seeder writing to one key while every subject reads another does not fail, it
 * reports `cached: "missing"` on every request and calls it a measurement.
 */
export { IO_REDIS_KEY, IO_TABLE };

export const IO_GREETING = 'Hello, World!';
export const IO_ROWS = 500;

const DEFAULT_PG = 'postgres://dunx:dunx@127.0.0.1:5432/dunx';
const DEFAULT_REDIS = 'redis://127.0.0.1:6379';

export interface IoServices {
  readonly pgUrl: string;
  readonly redisUrl: string;
}

export const ioServices = (): IoServices => ({
  pgUrl: process.env['BENCH_PG_URL'] ?? DEFAULT_PG,
  redisUrl: process.env['BENCH_REDIS_URL'] ?? DEFAULT_REDIS,
});

/**
 * `id` is the row number and `amount` is a hundred times it, so the contract's
 * `{"id":1,"memo":"row 1","amount":100}` is derivable rather than magic. 500 rows
 * so the planner has an index to use rather than a one-row table it scans.
 */
export const seedIo = async (services: IoServices): Promise<void> => {
  const sql = new SQL({ url: services.pgUrl, max: 1 });
  try {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${IO_TABLE} (
      id integer PRIMARY KEY,
      memo text NOT NULL,
      amount integer NOT NULL
    )`);
    await sql.unsafe(`TRUNCATE ${IO_TABLE}`);
    for (let index = 1; index <= IO_ROWS; index += 1) {
      await sql.unsafe(
        `INSERT INTO ${IO_TABLE} (id, memo, amount) VALUES ($1, $2, $3)`,
        [index, `row ${index}`, index * 100],
      );
    }
    await sql.unsafe(`ANALYZE ${IO_TABLE}`);
  } finally {
    await sql.close();
  }

  const redis = new RedisClient(services.redisUrl);
  try {
    await redis.set(IO_REDIS_KEY, IO_GREETING);
  } finally {
    redis.close();
  }
};

export interface IoProbe {
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * Connections the harness itself and Postgres' own reserve need on top of the
 * subjects'. Three are `superuser_reserved_connections` by default and one is the
 * seeding client; the rest is slack for a `psql` someone left open.
 */
const CONNECTION_SLACK = 8;

/**
 * **The scenario's hardest precondition, and the one that fails silently.**
 *
 * Measured rounds are interleaved, so every subject is up and pooled at the same
 * time: twenty subjects at `IO_POOL_SIZE` want 160 connections against Postgres'
 * default `max_connections` of 100. What that produced was not an error - it was
 * a table. Two Node subjects died of an unhandled pool rejection and were
 * recorded at 560,964 req/s of pure connection failures, four more served 5xx for
 * a fifth of their requests, and every one of those rows had a number in it.
 *
 * So the budget is checked before anything is measured, and a run that does not
 * fit drops the scenario with the figure to set rather than publishing that.
 */
const connectionBudget = async (
  services: IoServices,
  subjects: number,
): Promise<string | null> => {
  const needed = subjects * IO_POOL_SIZE + CONNECTION_SLACK;
  const sql = new SQL({ url: services.pgUrl, max: 1 });
  try {
    const rows = (await sql.unsafe('SHOW max_connections')) as {
      max_connections: string;
    }[];
    const limit = Number(rows[0]?.max_connections ?? 0);
    if (limit >= needed) return null;
    return (
      `Postgres allows ${limit} connections and this run needs ${needed} ` +
      `(${subjects} subjects x a pool of ${IO_POOL_SIZE}, plus ${CONNECTION_SLACK} for the harness ` +
      `and Postgres' own reserve). Every subject is up at once because the rounds ` +
      `are interleaved.\nRaise it - ` +
      `\`docker run ... postgres:17-alpine -c max_connections=${Math.max(needed, 200)}\` - ` +
      `or pass fewer --subjects.`
    );
  } finally {
    await sql.close();
  }
};

export const probeIo = async (
  services: IoServices,
  subjects: number,
): Promise<IoProbe> => {
  try {
    const budget = await connectionBudget(services, subjects);
    if (budget !== null) return { ok: false, reason: budget };
    await seedIo(services);
    return { ok: true, reason: '' };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

export const IO_SCENARIO = 'io';

/**
 * The `io` scenario is the only one needing anything outside the subject process,
 * and it reaches its services through the environment rather than through a flag
 * twenty server files would each have to parse. A subject spawns fresh per
 * scenario, so the other four never see these and open no socket.
 */
export const ioEnvFor = (
  scenario: Scenario,
  services: IoServices,
): Record<string, string> =>
  scenario.id === IO_SCENARIO
    ? { BENCH_IO_PG_URL: services.pgUrl, BENCH_IO_REDIS_URL: services.redisUrl }
    : {};

/** Either URL with any password stripped, so a log never carries one. */
const redacted = (url: string): string => url.replace(/\/\/[^@/]*@/, '//');

export interface IoPlan {
  readonly scenarios: readonly Scenario[];
  readonly services: IoServices;
  readonly note: string | null;
}

/**
 * Probes and seeds once, before anything is measured. A subject must not seed its
 * own fixture, and a machine with no Redis and no Postgres drops the scenario
 * rather than failing the run - the same contract a missing toolchain gets.
 */
export const planIo = async (
  scenarios: readonly Scenario[],
  subjects: number,
): Promise<IoPlan> => {
  const services = ioServices();
  if (!scenarios.some((scenario) => scenario.id === IO_SCENARIO)) {
    return { scenarios, services, note: null };
  }
  const probe = await probeIo(services, subjects);
  if (probe.ok) {
    return {
      scenarios,
      services,
      note: `io fixture seeded: ${redacted(services.redisUrl)} and ${redacted(services.pgUrl)}`,
    };
  }
  return {
    scenarios: scenarios.filter((scenario) => scenario.id !== IO_SCENARIO),
    services,
    note:
      `No Redis or Postgres for the io scenario - skipping it. ${probe.reason}\n` +
      'Set BENCH_REDIS_URL and BENCH_PG_URL, or start the services.',
  };
};
