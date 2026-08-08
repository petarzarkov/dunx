import { describe, expect, it } from 'bun:test';
import { authFor, configured, type AuthState } from './auth';
import {
  entriesOf,
  groupByTag,
  matches,
  type OpenApiDocument,
  type SecuritySchemeObject,
} from './model';
import { buildHeaders, buildUrl, type RequestSpec } from './send';

const schemes: Record<string, SecuritySchemeObject> = {
  bearer: { type: 'http', scheme: 'bearer' },
  basic: { type: 'http', scheme: 'basic' },
  header: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
  query: { type: 'apiKey', in: 'query', name: 'api_key' },
  cookie: { type: 'apiKey', in: 'cookie', name: 'sid' },
};

const held = (value: string): AuthState['x'] => ({
  value,
  user: '',
  pass: '',
});

describe('credentials entered once', () => {
  it('sends a bearer token as a bearer token, once only', () => {
    const state = { bearer: held('t0ken') };
    expect(authFor(schemes, state, ['bearer']).headers).toEqual({
      Authorization: 'Bearer t0ken',
    });
    // Pasting the whole header value is what people actually do.
    expect(
      authFor(schemes, { bearer: held('Bearer t0ken') }, ['bearer']).headers,
    ).toEqual({ Authorization: 'Bearer t0ken' });
  });

  it('honours where an apiKey says it travels', () => {
    expect(authFor(schemes, { header: held('k') }, ['header'])).toEqual({
      headers: { 'X-Api-Key': 'k' },
      query: {},
    });
    expect(authFor(schemes, { query: held('k') }, ['query'])).toEqual({
      headers: {},
      query: { api_key: 'k' },
    });
    // `fetch` will not let a page set a cookie, so nothing is pretended.
    expect(authFor(schemes, { cookie: held('k') }, ['cookie'])).toEqual({
      headers: {},
      query: {},
    });
  });

  it('encodes HTTP basic from the two fields it asked for', () => {
    const state = { basic: { value: '', user: 'ada', pass: 'l0velace' } };
    expect(authFor(schemes, state, ['basic']).headers).toEqual({
      Authorization: `Basic ${btoa('ada:l0velace')}`,
    });
    expect(configured(schemes, state)).toEqual(['basic']);
  });

  it('attaches nothing for a scheme the operation does not ask for', () => {
    const state = { bearer: held('t0ken') };
    expect(authFor(schemes, state, [])).toEqual({ headers: {}, query: {} });
    expect(authFor(schemes, {}, ['bearer'])).toEqual({
      headers: {},
      query: {},
    });
    expect(configured(schemes, {})).toEqual([]);
  });
});

const spec = (over: Partial<RequestSpec>): RequestSpec => ({
  method: 'get',
  path: '/notes/{id}',
  fields: [
    { name: 'id', in: 'path', required: true, placeholder: 'string' },
    { name: 'expand', in: 'query', required: false, placeholder: '' },
  ],
  values: {},
  headerLines: '',
  auth: { headers: {}, query: {} },
  ...over,
});

describe('assembling a request', () => {
  it('substitutes path parameters and skips empty query parameters', () => {
    const url = buildUrl(
      spec({ values: { 'path:id': ' 7 ', 'query:expand': '  ' } }),
      'http://api.test',
    );
    expect(String(url)).toBe('http://api.test/notes/7');
  });

  it('appends a filled query parameter, encoded', () => {
    const url = buildUrl(
      spec({ values: { 'path:id': 'a b', 'query:expand': 'author' } }),
      'http://api.test',
    );
    expect(String(url)).toBe('http://api.test/notes/a%20b?expand=author');
  });

  it('adds an apiKey that travels in the query', () => {
    const url = buildUrl(
      spec({
        values: { 'path:id': '1' },
        auth: { headers: {}, query: { api_key: 'k' } },
      }),
      'http://api.test',
    );
    expect(url.searchParams.get('api_key')).toBe('k');
  });

  it('lets a hand-typed header win over the dialog', () => {
    const headers = buildHeaders(
      spec({
        auth: { headers: { Authorization: 'Bearer from-dialog' }, query: {} },
        headerLines: 'Authorization: Bearer typed\nX-Trace: abc\nnonsense',
      }),
    );
    expect(headers).toEqual({
      Authorization: 'Bearer typed',
      'X-Trace': 'abc',
    });
  });

  it('declares a JSON content type only where there is a body to send', () => {
    expect(buildHeaders(spec({ body: '{}' }))['content-type']).toBeUndefined();
    expect(
      buildHeaders(spec({ method: 'post', body: '{}' }))['content-type'],
    ).toBe('application/json');
  });
});

const document: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'T', version: '1' },
  paths: {
    '/a': {
      get: { operationId: 'A_get', tags: ['One'], responses: {} },
      post: { operationId: 'A_post', tags: ['Two'], responses: {} },
    },
    '/b': { get: { operationId: 'B_get', responses: {} } },
  },
  components: { schemas: {} },
};

describe('reading the document', () => {
  it('groups by tag, defaulting an untagged operation', () => {
    expect(groupByTag(entriesOf(document)).map(([tag]) => tag)).toEqual([
      'default',
      'One',
      'Two',
    ]);
  });

  it('filters on anything the reader can see', () => {
    const [entry] = entriesOf(document);
    expect(matches(entry!, '')).toBe(true);
    expect(matches(entry!, 'A_GET')).toBe(true);
    expect(matches(entry!, '/a')).toBe(true);
    expect(matches(entry!, 'nope')).toBe(false);
  });
});
