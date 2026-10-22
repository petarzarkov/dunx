import { expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import type { BunRequest } from 'bun';
import { Controller, Post } from '../route/decorators.js';
import type { Input } from '../route/schema.js';
import { HttpError, ValidationError } from './errors.js';
import { HttpFactory } from './factory.js';
import { buildInputReader } from './input.js';
import { RawBody } from './raw-body.js';
import { Note, schema } from './schema.fixture.js';
import { serving } from './serving.fixture.js';
import type { Middleware, Next } from './middleware.js';
import type { RouteContext } from './context.js';

const request = (body = 'hello'): BunRequest =>
  Object.assign(
    new Request('http://localhost/notes?filter[text]=query', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body,
    }),
    { params: { id: '7' }, cookies: new Bun.CookieMap('session=abc') },
  ) as unknown as BunRequest;

const custom = {
  body: Note,
  bodyParser: async (req: BunRequest) => ({ text: await req.text() }),
  query: Note,
  queryParser: (req: BunRequest) => ({
    text: new URL(req.url).searchParams.get('filter[text]'),
  }),
} as const;

@Controller('notes')
class NotesController {
  @Post('/', custom)
  create(input: Input<typeof custom>) {
    return { body: input.body, query: input.query };
  }
}
@Module({ controllers: [NotesController] })
class AppModule {}

class BufferBody implements Middleware {
  async handle(req: BunRequest, _ctx: RouteContext, next: Next) {
    RawBody.buffer(req, new Uint8Array(await req.arrayBuffer()));
    return next();
  }
}

for (const buffered of [false, true]) {
  it(`parses a custom media type and nested query with buffered=${buffered}`, async () => {
    await serving(
      () =>
        HttpFactory.create(AppModule, {
          bootLogging: false,
          requestLogging: false,
          middleware: buffered ? [BufferBody] : [],
        }),
      async (_app, url) => {
        const response = await fetch(`${url}/notes?filter[text]=query`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: 'hello',
        });
        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({
          body: { text: 'hello' },
          query: { text: 'query' },
        });
      },
    );
  });
}

it('keeps a custom query parser and synchronous validator synchronous', () => {
  const result = buildInputReader({
    query: custom.query,
    queryParser: custom.queryParser,
  })(request());
  expect(result).not.toBeInstanceOf(Promise);
  expect(result).toHaveProperty('query', { text: 'query' });
});

it('awaits an asynchronous query parser before validating', async () => {
  const result = buildInputReader({
    query: Note,
    queryParser: async (req) => custom.queryParser(req),
  })(request());
  expect(result).toBeInstanceOf(Promise);
  expect(await result).toHaveProperty('query', { text: 'query' });
});

it('validates parser output, including asynchronous schemas', async () => {
  await expect(
    buildInputReader({ body: Note, bodyParser: () => ({ text: 7 }) })(
      request(),
    ),
  ).rejects.toBeInstanceOf(ValidationError);
  const upper = schema<{ text: string }>(async () => ({
    value: { text: 'UPPER' },
  }));
  expect(
    await buildInputReader({ body: upper, bodyParser: custom.bodyParser })(
      request(),
    ),
  ).toHaveProperty('body', { text: 'UPPER' });
});

it('does not invoke a parser without its matching schema', () => {
  const fail = () => {
    throw new Error('must not run');
  };
  expect(
    buildInputReader({ bodyParser: fail, queryParser: fail })(request()),
  ).not.toBeInstanceOf(Promise);
});

it('preserves explicit parser errors', async () => {
  const error = new HttpError(422, 'invalid custom payload');
  await expect(
    buildInputReader({
      body: Note,
      bodyParser: async () => {
        throw error;
      },
    })(request()),
  ).rejects.toBe(error);
  expect(() =>
    buildInputReader({
      query: Note,
      queryParser: () => {
        throw error;
      },
    })(request()),
  ).toThrow(error);
});

it('replays a body already consumed by middleware and preserves request details', async () => {
  const req = request();
  RawBody.buffer(req, new Uint8Array(await req.arrayBuffer()));
  RawBody.want(req);
  const result = await buildInputReader({
    body: Note,
    bodyParser: async (source) => {
      expect(source.url).toBe(req.url);
      expect(source.method).toBe('POST');
      expect(source.params).toEqual({ id: '7' });
      expect(source.cookies.get('session')).toBe('abc');
      expect(source.headers.get('content-type')).toBe(
        'application/octet-stream',
      );
      return { text: await source.text() };
    },
  })(req);
  expect(result.body).toEqual({ text: 'hello' });
  expect(RawBody.read(req)).toBe('hello');
});

it('records the original body for logging before custom validation', async () => {
  const req = request();
  RawBody.want(req);
  await expect(
    buildInputReader({
      body: Note,
      bodyParser: async (source) => {
        await source.text();
        return {};
      },
    })(req),
  ).rejects.toBeInstanceOf(ValidationError);
  expect(RawBody.read(req)).toBe('hello');
});

it('validates custom queries and preserves synchronous body parser errors', async () => {
  expect(() =>
    buildInputReader({ query: Note, queryParser: () => ({ text: 7 }) })(
      request(),
    ),
  ).toThrow(ValidationError);
  const error = new HttpError(422, 'invalid custom payload');
  expect(() =>
    buildInputReader({
      body: Note,
      bodyParser: () => {
        throw error;
      },
    })(request()),
  ).toThrow(error);
  const upper = schema<{ text: string }>(async () => ({
    value: { text: 'UPPER' },
  }));
  expect(
    await buildInputReader({ query: upper, queryParser: custom.queryParser })(
      request(),
    ),
  ).toHaveProperty('query', { text: 'UPPER' });
});
