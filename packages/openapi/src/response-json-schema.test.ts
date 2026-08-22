import { describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import { Controller, Get } from '@dunx/http';
import { describeRoutes } from './discover.js';
import { generateDocument } from './generate.js';
import { danglingRefs } from './refs.js';
import type {
  OpenApiDocument,
  OperationKey,
  OperationObject,
} from './types.js';

const info = { title: 'Test API', version: '2.1.0' } as const;

const operationOf = (
  document: OpenApiDocument,
  path: string,
  method: OperationKey,
): OperationObject => {
  const operation = document.paths[path]?.[method];
  if (operation === undefined) throw new Error(`no ${method} on ${path}`);
  return operation;
};

/**
 * A JSON Schema needs no conversion, so `response` takes one directly. This is what
 * lets `@dunx/http` document `HEALTH_REPORT_SCHEMA` without taking a validator
 * dependency to describe two routes.
 */
describe('a plain JSON Schema response', () => {
  const Pong = Object.freeze({
    type: 'object',
    properties: { pong: { type: 'boolean' } },
    required: ['pong'],
  });

  const Named = Object.freeze({
    $id: 'Named',
    type: 'object',
    properties: { at: { type: 'string' } },
  });

  @Controller('raw')
  class RawController {
    @Get('/inline', { response: { 200: Pong } })
    inline(): { pong: true } {
      return { pong: true };
    }

    @Get('/named', { response: { 200: Named, 503: Named } })
    named(): { at: string } {
      return { at: 'now' };
    }
  }

  @Module({ controllers: [RawController] })
  class AppModule {}

  const document = async () =>
    (await generateDocument(describeRoutes(AppModule), info)).document;

  it('passes an anonymous one through verbatim', async () => {
    const operation = operationOf(await document(), '/raw/inline', 'get');

    expect(
      operation.responses['200']?.content?.['application/json']?.schema,
    ).toEqual(Pong);
  });

  it('hoists an $id one once and refs it from every status', async () => {
    const doc = await document();
    const operation = operationOf(doc, '/raw/named', 'get');

    for (const code of ['200', '503']) {
      expect(
        operation.responses[code]?.content?.['application/json']?.schema,
      ).toEqual({ $ref: '#/components/schemas/Named' });
    }
    // `$id` named the schema; it does not describe it, so it is not in the body.
    // `title` is added from the component name, which is what lets an explorer
    // label this schema where it appears nested rather than as a root `$ref`.
    expect(doc.components?.schemas?.['Named']).toEqual({
      title: 'Named',
      type: 'object',
      properties: { at: { type: 'string' } },
    });
    expect(danglingRefs(doc)).toEqual([]);
  });

  it('still describes each status from the status code', async () => {
    const operation = operationOf(await document(), '/raw/named', 'get');

    expect(operation.responses['200']?.description).toBe('OK');
    expect(operation.responses['503']?.description).toBe('Service unavailable');
  });
});

describe('titles on hoisted schemas', () => {
  const Untitled = Object.freeze({ $id: 'Untitled', type: 'object' });
  const Titled = Object.freeze({
    $id: 'Titled',
    title: 'Chosen',
    type: 'object',
  });

  @Controller('titles')
  class TitlesController {
    @Get('/a', { response: { 200: Untitled } })
    a(): unknown {
      return {};
    }

    @Get('/b', { response: { 200: Titled } })
    b(): unknown {
      return {};
    }
  }

  @Module({ controllers: [TitlesController] })
  class AppModule {}

  const document = async () =>
    (await generateDocument(describeRoutes(AppModule), info)).document;

  it('titles an untitled schema by its component name', async () => {
    expect((await document()).components?.schemas?.['Untitled']).toEqual({
      title: 'Untitled',
      type: 'object',
    });
  });

  it('leaves a declared title alone', async () => {
    // An explicit choice wins: the key names the slot, the title names the model.
    expect((await document()).components?.schemas?.['Titled']).toEqual({
      title: 'Chosen',
      type: 'object',
    });
  });
});
