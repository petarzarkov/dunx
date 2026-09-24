import { describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import {
  Controller,
  Get,
  Idempotent,
  IDEMPOTENCY_KEY_PATTERN,
  Post,
  type Input,
} from '@dunx/http';
import { z } from 'zod';
import { describeRoutes } from './discover.js';
import { info, operationOf } from './document.fixture.js';
import { generateDocument } from './generate.js';
import type { ParameterObject } from './types.js';

const charge = { body: z.object({ amount: z.number().int() }) } as const;

@Controller('charges')
class ChargesController {
  @Idempotent({ required: true })
  @Post('/', charge)
  create(_input: Input<typeof charge>): { ok: boolean } {
    return { ok: true };
  }

  @Idempotent()
  @Post('/refund')
  refund(): { ok: boolean } {
    return { ok: true };
  }

  @Post('/plain')
  plain(): { ok: boolean } {
    return { ok: true };
  }
}

@Idempotent()
@Controller('carts')
class CartsController {
  @Get('/')
  list(): readonly string[] {
    return [];
  }
}

@Module({ controllers: [ChargesController, CartsController] })
class ChargesModule {}

const built = generateDocument(describeRoutes(ChargesModule), info);

const header = (required: boolean): ParameterObject => ({
  name: 'Idempotency-Key',
  in: 'header',
  required,
  description:
    'Unique per operation. A retry with the same key and request replays the ' +
    'first response.',
  schema: {
    type: 'string',
    minLength: 1,
    maxLength: 255,
    pattern: IDEMPOTENCY_KEY_PATTERN,
  },
});

describe('@Idempotent() in the document', () => {
  it('adds the header, required where the route requires it', async () => {
    const { document } = await built;
    expect(operationOf(document, '/charges', 'post').parameters).toEqual([
      header(true),
    ]);
    expect(operationOf(document, '/charges/refund', 'post').parameters).toEqual(
      [header(false)],
    );
  });

  it('documents 409 and 422, and a 400 where no schema already did', async () => {
    const { document } = await built;
    const refund = operationOf(document, '/charges/refund', 'post').responses;
    expect(Object.keys(refund)).toEqual(['201', '400', '409', '422']);
    expect(refund['409']?.description).toBe(
      'A request with this Idempotency-Key is still running',
    );
    expect(refund['422']?.description).toBe(
      'This Idempotency-Key was used with a different request',
    );
    expect(refund['400']?.description).toBe(
      'The Idempotency-Key is missing or malformed',
    );
    // The validation 400 stays, schema and all.
    const create = operationOf(document, '/charges', 'post').responses;
    expect(create['400']?.description).toBe(
      'A declared schema rejected the request',
    );
  });

  it('leaves undecorated routes and GETs alone', async () => {
    const { document } = await built;
    const plain = operationOf(document, '/charges/plain', 'post');
    expect(plain.parameters).toBeUndefined();
    expect(Object.keys(plain.responses)).toEqual(['201']);
    const list = operationOf(document, '/carts', 'get');
    expect(list.parameters).toBeUndefined();
    expect(Object.keys(list.responses)).toEqual(['200']);
  });
});
