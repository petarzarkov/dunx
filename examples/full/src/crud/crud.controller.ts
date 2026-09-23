import { Delete, Get, HttpError, HttpStatusCode, type Input } from '@dunx/http';
import { z } from 'zod';

export interface Row {
  readonly id: string;
}

/** An in-memory table. A subclass seeds it and is what the container injects. */
export abstract class CrudStore<T extends Row> {
  readonly #rows: Map<string, T>;

  constructor(rows: readonly T[]) {
    this.#rows = new Map(rows.map((row) => [row.id, row]));
  }

  list(): readonly T[] {
    return [...this.#rows.values()];
  }

  one(id: string): T | undefined {
    return this.#rows.get(id);
  }

  remove(id: string): boolean {
    return this.#rows.delete(id);
  }
}

const byId = { params: z.object({ id: z.string() }) } as const;

/**
 * Every handler is declared once, here. A subclass picks which of them it serves
 * with `@Controller(prefix, { include, exclude })`, which is read off the class,
 * so the server, `@dunx/testing` and the OpenAPI document agree on the routes.
 */
export abstract class CrudController<T extends Row> {
  constructor(private readonly store: CrudStore<T>) {}

  @Get('/')
  getList(): readonly T[] {
    return this.store.list();
  }

  @Get('/:id', byId)
  getOne({ params }: Input<typeof byId>): T {
    const row = this.store.one(params.id);
    if (row === undefined) {
      throw new HttpError(HttpStatusCode.NOT_FOUND, `No row ${params.id}`);
    }
    return row;
  }

  @Delete('/:id', byId)
  remove({ params }: Input<typeof byId>): { removed: boolean } {
    return { removed: this.store.remove(params.id) };
  }
}
