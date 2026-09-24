import type {
  SpanAttributes,
  SpanAttributeValue,
  SpanOptions,
  Tracer,
} from '@dunx/core';
import type { DbConnection } from './connection.js';
import type { DialectName } from './dialect.js';
import type { QueryObserver } from './instrument.js';
import { sanitize, summarise } from './statement.js';

/** The semantic conventions' `db.system.name` for each dialect. */
const SYSTEMS: Readonly<Record<DialectName, string>> = {
  postgres: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  sqlite: 'sqlite',
};

/**
 * What a `Bun.SQL` client says about where it is connected: the database, host
 * and port. Read once per connection; `bun:sqlite` has no server to name.
 */
const serverOf = (raw: unknown): Record<string, SpanAttributeValue> => {
  if (typeof raw !== 'function') return {};
  const options: unknown = Reflect.get(raw, 'options');
  if (typeof options !== 'object' || options === null) return {};
  const found: Record<string, SpanAttributeValue> = {};
  const database: unknown = Reflect.get(options, 'database');
  const hostname: unknown = Reflect.get(options, 'hostname');
  const port: unknown = Reflect.get(options, 'port');
  if (typeof database === 'string' && database !== '') {
    found['db.namespace'] = database;
  }
  if (typeof hostname === 'string' && hostname !== '') {
    found['server.address'] = hostname;
  }
  if (typeof port === 'number') found['server.port'] = port;
  return found;
};

/**
 * One CLIENT span per statement execution, named `{operation} {table}` when the
 * statement gives both away cheaply, by the operation alone when only that, and
 * by the database system when neither.
 *
 * `db.query.text` is the statement with its literals replaced: what drizzle
 * builds is parameterised already, and a hand-written `sql` escape hatch is not.
 * Parameters are never read.
 *
 * Only constructed when the bound `Tracer` is not the no-op, so a driver nobody
 * traces is never wrapped for it.
 */
export class QuerySpans implements QueryObserver {
  readonly #system: string;
  readonly #base: SpanAttributes;

  constructor(
    private readonly tracer: Tracer,
    connection: DbConnection<unknown>,
  ) {
    this.#system = SYSTEMS[connection.dialect];
    this.#base = {
      'db.system.name': this.#system,
      ...serverOf(connection.raw),
    };
  }

  run<T>(sql: string, execute: () => T): T {
    const { name, options } = this.#span(sql);
    return this.tracer.span(name, options, execute);
  }

  rejected(sql: string, error: unknown): void {
    const { name, options } = this.#span(sql);
    this.tracer.span(name, options, (span) => span.recordError(error));
  }

  #span(sql: string): { name: string; options: SpanOptions } {
    const shape = sanitize(sql);
    const { operation, target } = summarise(shape);
    const attributes: Record<string, SpanAttributeValue> = {
      ...this.#base,
      'db.query.text': shape,
    };
    if (operation !== undefined) attributes['db.operation.name'] = operation;
    if (target !== undefined) attributes['db.collection.name'] = target;
    const name =
      operation !== undefined && target !== undefined
        ? `${operation} ${target}`
        : (operation ?? this.#system);
    return { name, options: { kind: 'client', attributes } };
  }
}
