import { describe, expect, it } from 'bun:test';
import { sampleFor } from './sample.js';
import type { JsonSchema } from './types.js';

/**
 * `sampleFor` fills the request body box on the docs page. It is best effort by
 * design, but its guesses are what a reader sends first — a wrong one produces a
 * 400 that looks like the framework's fault, so the precedence rules and the
 * recursion guard are worth pinning down.
 */
const schemas: Readonly<Record<string, JsonSchema>> = {
  Tag: { type: 'object', properties: { label: { type: 'string' } } },
  Node: {
    type: 'object',
    properties: { child: { $ref: '#/components/schemas/Node' } },
  },
};

describe('sampleFor', () => {
  it('prefers an explicit example over everything else', () => {
    expect(
      sampleFor(
        { type: 'string', default: 'ignored', example: 'the example' },
        {},
      ),
    ).toBe('the example');
  });

  it('falls back to default, then const, then the first enum member', () => {
    expect(sampleFor({ type: 'string', default: 'dflt' }, {})).toBe('dflt');
    expect(sampleFor({ type: 'string', const: 'fixed' }, {})).toBe('fixed');
    expect(sampleFor({ type: 'string', enum: ['first', 'second'] }, {})).toBe(
      'first',
    );
  });

  it('resolves a $ref against components', () => {
    expect(sampleFor({ $ref: '#/components/schemas/Tag' }, schemas)).toEqual({
      label: 'string',
    });
  });

  it('answers an unresolvable $ref with null rather than throwing', () => {
    expect(sampleFor({ $ref: '#/components/schemas/Missing' }, schemas)).toBe(
      null,
    );
  });

  it('takes the first branch of a union', () => {
    expect(
      sampleFor({ oneOf: [{ type: 'integer' }, { type: 'string' }] }, {}),
    ).toBe(0);
    expect(
      sampleFor({ anyOf: [{ type: 'boolean' }, { type: 'string' }] }, {}),
    ).toBe(false);
    expect(sampleFor({ allOf: [{ type: 'string' }] }, {})).toBe('string');
  });

  it('honours minimum and maximum on a number', () => {
    expect(sampleFor({ type: 'integer', minimum: 18 }, {})).toBe(18);
    expect(sampleFor({ type: 'integer', maximum: 5 }, {})).toBe(5);
    expect(sampleFor({ type: 'number' }, {})).toBe(0);
  });

  it('produces a plausible string for a known format', () => {
    expect(sampleFor({ type: 'string', format: 'email' }, {})).toBe(
      'user@example.com',
    );
    expect(sampleFor({ type: 'string', format: 'uuid' }, {})).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(sampleFor({ type: 'string', format: 'date' }, {})).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    expect(sampleFor({ type: 'string', format: 'uri' }, {})).toBe(
      'https://example.com',
    );
  });

  it('satisfies minLength when it is longer than the placeholder', () => {
    const value = sampleFor({ type: 'string', minLength: 12 }, {});
    expect(typeof value).toBe('string');
    expect((value as string).length).toBeGreaterThanOrEqual(12);
    // A short minimum keeps the readable placeholder.
    expect(sampleFor({ type: 'string', minLength: 2 }, {})).toBe('string');
  });

  it('wraps an array item, and answers an itemless array empty', () => {
    expect(sampleFor({ type: 'array', items: { type: 'string' } }, {})).toEqual(
      ['string'],
    );
    expect(sampleFor({ type: 'array' }, {})).toEqual([]);
  });

  it('covers the remaining scalars', () => {
    expect(sampleFor({ type: 'boolean' }, {})).toBe(false);
    expect(sampleFor({ type: 'null' }, {})).toBe(null);
    // A type union takes its first member.
    expect(sampleFor({ type: ['integer', 'string'] }, {})).toBe(0);
  });

  it('answers an object with no properties as an empty object', () => {
    expect(sampleFor({ type: 'object' }, {})).toEqual({});
  });

  it('answers a schema with no type and no composition as null', () => {
    expect(sampleFor({}, {})).toBe(null);
    // ...unless it has properties, which imply an object even untyped.
    expect(sampleFor({ properties: { a: { type: 'string' } } }, {})).toEqual(
      {},
    );
  });

  it('terminates on a self-referencing $ref instead of recursing forever', () => {
    // Without the depth cap this is an infinite descent, which on the docs page
    // would be a hung request rather than a bad guess.
    const value = sampleFor({ $ref: '#/components/schemas/Node' }, schemas);
    expect(value).toBeDefined();
    expect(JSON.stringify(value).length).toBeLessThan(200);
  });

  it('is serialisable, which is the only thing the caller does with it', () => {
    const body = sampleFor(
      {
        type: 'object',
        properties: {
          name: { type: 'string' },
          tags: { type: 'array', items: { $ref: '#/components/schemas/Tag' } },
          age: { type: 'integer', minimum: 18 },
        },
      },
      schemas,
    );

    expect(JSON.parse(JSON.stringify(body))).toEqual({
      name: 'string',
      tags: [{ label: 'string' }],
      age: 18,
    });
  });
});
