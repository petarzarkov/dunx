import { describe, expect, it } from 'bun:test';
import type { BunRequest } from 'bun';
import type { SseInput } from '../sse/decorators.js';
import type { Input } from './schema.js';

const request = (): BunRequest =>
  new Request('http://localhost/') as BunRequest;

describe('Input defaults its type argument', () => {
  it('types a route with no schemas as the request alone', () => {
    const read = (input: Input): string | null =>
      input.req.headers.get('x-trace');

    expect(read({ req: request() })).toBeNull();
  });

  it('SseInput defaults to SseSchemas and keeps the resume header', () => {
    const read = (input: SseInput): string | undefined => input.lastEventId;

    expect(read({ req: request(), lastEventId: '7' })).toBe('7');
  });
});
