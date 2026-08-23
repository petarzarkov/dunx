import {
  Controller,
  Delete,
  Get,
  HttpError,
  HttpStatusCode,
  Post,
  type Input,
} from '@dunx/http';
import { PAGINATION, type Page } from '@dunx/infra/pagination';
import { z } from 'zod';
import { Ledger } from './ledger.service.js';
import type { Entry } from './schema.js';

const EntryIndex = z
  .object({ id: z.coerce.number().int().min(1) })
  .meta({ id: 'EntryIndex', description: 'A ledger entry id in the path' });

const CreateEntry = z
  .object({
    memo: z.string().min(1).max(80),
    amount: z.number().int(),
  })
  .meta({ id: 'CreateEntry', description: 'A single ledger movement' });

const Transfer = z
  .object({
    from: z.string().min(1).max(80),
    to: z.string().min(1).max(80),
    amount: z.number().int().positive(),
    /** Throws between the two legs: a 409 with an unchanged row count is how
     * the rollback is visible from outside. */
    fail: z.boolean().default(false),
  })
  .meta({ id: 'Transfer', description: 'Move an amount between two memos' });

const listEntries = {
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
} as const;
/**
 * The page query as zod. `@dunx/infra/pagination` ships no schema - validation
 * targets Standard Schema, so the app picks the library - and stating it here is
 * what puts the parameters in the OpenAPI document. `PAGINATION` supplies the
 * bounds so they cannot drift from `parsePageOptions`.
 */
const pageQuery = z
  .object({
    take: z.coerce
      .number()
      .int()
      .min(PAGINATION.MIN_TAKE)
      .max(PAGINATION.MAX_TAKE)
      .default(PAGINATION.DEFAULT_TAKE),
    order: z.enum(['asc', 'desc']).default(PAGINATION.DEFAULT_ORDER),
    direction: z
      .enum(['forward', 'backward'])
      .default(PAGINATION.DEFAULT_DIRECTION),
    cursor: z
      .string()
      .max(PAGINATION.MAX_CURSOR)
      .optional()
      .describe('Opaque cursor from meta.nextCursor. Omit for the first page.'),
  })
  .meta({
    id: 'LedgerPageQuery',
    description: 'Keyset pagination over the ledger',
  });

const pagedEntries = { query: pageQuery } as const;
const oneEntry = { params: EntryIndex } as const;
const createEntry = { body: CreateEntry } as const;
const transfer = { body: Transfer } as const;

@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledger: Ledger) {}

  @Get('/', listEntries)
  list(input: Input<typeof listEntries>): {
    entries: readonly Entry[];
    balance: number;
  } {
    return {
      entries: this.ledger.list(input.query.limit),
      balance: this.ledger.balance(),
    };
  }

  /** Walked by cursor. Declared before `/:id` for readability only: `Bun.serve`
   * matches a static segment ahead of a parameter. */
  @Get('/page', pagedEntries)
  page(input: Input<typeof pagedEntries>): Page<Entry> {
    return this.ledger.page(input.query);
  }

  @Get('/:id', oneEntry)
  one(input: Input<typeof oneEntry>): Entry {
    const entry = this.ledger.find(input.params.id);
    if (entry === undefined) {
      throw new HttpError(
        HttpStatusCode.NOT_FOUND,
        `No ledger entry ${input.params.id}`,
      );
    }
    return entry;
  }

  @Post('/', createEntry)
  create(input: Input<typeof createEntry>): Entry {
    return this.ledger.add(input.body.memo, input.body.amount);
  }

  /** `"fail": true` throws between the two inserts; the 409's unchanged `rows`
   * is proof the first leg rolled back. */
  @Post('/transfer', transfer)
  async transfer(
    input: Input<typeof transfer>,
  ): Promise<{ balance: number; rows: number }> {
    const { from, to, amount, fail } = input.body;
    try {
      const balance = await this.ledger.transfer(from, to, amount, fail);
      return { balance, rows: this.ledger.rows() };
    } catch (error) {
      throw new HttpError(
        HttpStatusCode.CONFLICT,
        `${(error as Error).message} - rolled back, still ${this.ledger.rows()} rows`,
      );
    }
  }

  /**
   * The same transfer with no `async` anywhere: the handler returns a value and
   * SQLite answers on the same tick. `SyncSqliteOptions` in `DatabaseModule` is
   * what allows it - `transactionSync` will not compile against the async handle.
   */
  @Post('/transfer-sync', transfer)
  transferSync(input: Input<typeof transfer>): {
    balance: number;
    rows: number;
  } {
    const { from, to, amount, fail } = input.body;
    try {
      const balance = this.ledger.transferSync(from, to, amount, fail);
      return { balance, rows: this.ledger.rows() };
    } catch (error) {
      throw new HttpError(
        HttpStatusCode.CONFLICT,
        `${(error as Error).message} - rolled back, still ${this.ledger.rows()} rows`,
      );
    }
  }

  @Delete('/:id', oneEntry)
  remove(input: Input<typeof oneEntry>): { deleted: boolean } {
    const deleted = this.ledger.remove(input.params.id);
    if (!deleted) {
      throw new HttpError(
        HttpStatusCode.NOT_FOUND,
        `No ledger entry ${input.params.id}`,
      );
    }
    return { deleted };
  }
}
