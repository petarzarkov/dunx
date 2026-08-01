import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { renderPage } from './html.js';
import type { OpenApiDocument } from './types.js';

/**
 * The inline client is the only runtime code the page carries, and a markup
 * assertion cannot prove it *sends* anything. This loads a rendered page into a
 * DOM, runs that script exactly as a browser would, and submits a form.
 *
 * `fetch` is stubbed rather than pointed at a real server: happy-dom replaces
 * the global `Response`, which a live `Bun.serve` in the same process then
 * rejects. What is under test is the client — URL assembly, headers, body,
 * rendering — not the server, which every other suite already covers.
 *
 * happy-dom is a devDependency; it never ships.
 */
interface Node {
  readonly dataset: Record<string, string | undefined>;
  readonly parentElement: Node | null;
  value: string;
  textContent: string | null;
  className: string;
  hidden: boolean;
  querySelector(selector: string): Node | null;
  dispatchEvent(event: unknown): void;
}

/** happy-dom installs these; the ambient types here are Bun's, which have neither. */
const browser = globalThis as unknown as {
  document: {
    querySelectorAll(selector: string): Iterable<Node>;
    write(html: string): void;
  };
  fetch: unknown;
};

const DOCUMENT: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Client', version: '1' },
  paths: {
    '/notes/{id}': {
      get: {
        operationId: 'Notes_one',
        tags: ['Notes'],
        parameters: [
          {
            name: 'expand',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/notes': {
      post: {
        operationId: 'Notes_create',
        tags: ['Notes'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { memo: { type: 'string' } },
              },
            },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
  },
  components: { schemas: {} },
};

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

const sent: Sent[] = [];
let reply: { status: number; statusText: string; body: string } = {
  status: 200,
  statusText: 'OK',
  body: '{"ok":true}',
};

const formFor = (method: string, path: string): Node => {
  // A NodeList, not an array — it has no `find`.
  const form = [...browser.document.querySelectorAll('form.try')].find(
    (node) =>
      node.dataset['path'] === path && node.dataset['method'] === method,
  );
  if (form === undefined) throw new Error(`no form for ${method} ${path}`);
  return form;
};

const send = async (form: Node): Promise<Node> => {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await Bun.sleep(20);
  const out = form.parentElement?.querySelector('.out');
  if (out === null || out === undefined) throw new Error('no output box');
  return out;
};

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://api.test/docs' });

  const page = renderPage(DOCUMENT, {
    jsonHref: '/openapi.json',
    warnings: [],
  });
  browser.document.write(page);

  browser.fetch = async (input: URL, init: Record<string, unknown>) => {
    sent.push({
      url: String(input),
      method: String(init['method']),
      headers: init['headers'] as Record<string, string>,
      body: init['body'] as string | undefined,
    });
    return new Response(reply.body, {
      status: reply.status,
      statusText: reply.statusText,
      headers: { 'content-type': 'application/json' },
    });
  };

  const script = page.slice(
    page.indexOf('<script>') + '<script>'.length,
    page.lastIndexOf('</script>'),
  );
  // Running the page's own script is the entire point of this suite; there is
  // no other way to execute what `renderPage` wrote.
  // oxlint-disable-next-line typescript/no-implied-eval
  new Function(script)();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe('the page client', () => {
  it('substitutes a path parameter and appends a non-empty query', async () => {
    sent.length = 0;
    reply = { status: 200, statusText: 'OK', body: '{"id":7}' };

    const form = formFor('get', '/notes/{id}');
    (form.querySelector('[data-in="path"]') as Node).value = '7';
    (form.querySelector('[data-in="query"]') as Node).value = 'author';
    const out = await send(form);

    // 7, not "{id}" — and the query only appears because it was filled in.
    expect(sent[0]?.url).toBe('http://api.test/notes/7?expand=author');
    expect(sent[0]?.method).toBe('GET');
    expect(sent[0]?.body).toBeUndefined();
    expect(out.querySelector('[data-status]')?.textContent).toContain('200 OK');
    expect(out.className).toContain('ok');
  });

  it('leaves an empty query parameter out of the URL entirely', async () => {
    sent.length = 0;
    const form = formFor('get', '/notes/{id}');
    (form.querySelector('[data-in="path"]') as Node).value = '9';
    (form.querySelector('[data-in="query"]') as Node).value = '   ';
    await send(form);

    expect(sent[0]?.url).toBe('http://api.test/notes/9');
  });

  it('sends the body with a JSON content type, and parsed headers', async () => {
    sent.length = 0;
    reply = { status: 201, statusText: 'Created', body: '{"created":true}' };

    const form = formFor('post', '/notes');
    (form.querySelector('[data-body]') as Node).value = '{"memo":"hi"}';
    (form.querySelector('[data-headers]') as Node).value =
      'Authorization: Bearer t0ken\nX-Trace: abc';
    const out = await send(form);

    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.body).toBe('{"memo":"hi"}');
    expect(sent[0]?.headers).toEqual({
      'content-type': 'application/json',
      Authorization: 'Bearer t0ken',
      'X-Trace': 'abc',
    });
    // Pretty-printed, because the response said it was JSON.
    expect(out.querySelector('[data-body-out]')?.textContent).toBe(
      '{\n  "created": true\n}',
    );
  });

  it('marks a rejected response as a failure rather than swallowing it', async () => {
    reply = {
      status: 400,
      statusText: 'Bad Request',
      body: '{"error":"nope"}',
    };

    const out = await send(formFor('post', '/notes'));

    expect(out.className).toContain('bad');
    expect(out.querySelector('[data-status]')?.textContent).toContain('400');
    expect(out.querySelector('[data-body-out]')?.textContent).toContain('nope');
  });
});
