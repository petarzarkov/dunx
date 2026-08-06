import type { Scenario } from './types.js';

export const VALIDATE_BODY = JSON.stringify({
  name: 'Ada Lovelace',
  age: 36,
  email: 'ada@example.com',
});

export const scenarios: readonly Scenario[] = [
  {
    id: 'plaintext',
    title: 'Plain text',
    description:
      'GET returning a fixed text/plain body. Measures raw request/response dispatch.',
    method: 'GET',
    path: '/plaintext',
    expectStatus: 200,
    expectBody: 'Hello, World!',
    expectMime: 'text/plain',
  },
  {
    id: 'json',
    title: 'JSON',
    description:
      'GET returning a small object serialised to JSON. Adds serialisation cost.',
    method: 'GET',
    path: '/json',
    expectStatus: 200,
    expectBody: '{"message":"Hello, World!"}',
    expectMime: 'application/json',
  },
  {
    id: 'params',
    title: 'Path parameter',
    description:
      'GET with one path parameter echoed back as JSON. Adds route-matching cost.',
    method: 'GET',
    path: '/params/42',
    expectStatus: 200,
    expectBody: '{"id":"42"}',
    expectMime: 'application/json',
  },
  {
    id: 'validate',
    title: 'Body validation',
    description:
      'POST with a JSON body parsed and validated against the same zod schema in every subject, echoed back.',
    method: 'POST',
    path: '/validate',
    body: VALIDATE_BODY,
    contentType: 'application/json',
    expectStatus: 200,
    expectBody: '{"name":"Ada Lovelace","age":36}',
    expectMime: 'application/json',
  },
];
