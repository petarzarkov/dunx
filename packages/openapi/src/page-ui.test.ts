import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { OpenApiDocument } from './types.js';
import { renderPage } from './ui.js';

/**
 * The inlined bundle is the page, and a string assertion cannot prove it renders
 * or that it *sends* anything. This loads a rendered page into a DOM, runs the
 * explorer exactly as a browser would, and submits an operation.
 *
 * `fetch` is stubbed rather than pointed at a real server: happy-dom replaces the
 * global `Response`, which a live `Bun.serve` in the same process then rejects.
 * What is under test is the page - boot, render, URL assembly, headers, body,
 * response rendering - not the server, which every other suite already covers.
 *
 * happy-dom is a devDependency; it never ships.
 */
interface El {
  readonly tagName: string;
  readonly dataset: Record<string, string | undefined>;
  readonly textContent: string | null;
  readonly children: ArrayLike<El>;
  value: string;
  click(): void;
  dispatchEvent(event: unknown): void;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): Iterable<El>;
  getAttribute(name: string): string | null;
  closest(selector: string): El | null;
}

const browser = globalThis as unknown as {
  document: {
    body: El;
    querySelector(selector: string): El | null;
    querySelectorAll(selector: string): Iterable<El>;
    write(html: string): void;
  };
  HTMLInputElement: { prototype: object };
  HTMLTextAreaElement: { prototype: object };
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
        summary: 'One note',
        parameters: [
          {
            name: 'expand',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
        ],
        responses: { '200': { description: 'OK' } },
        security: [{ bearer: [] }],
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
  components: {
    schemas: {},
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
  },
};

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

const sent: Sent[] = [];
let reply = { status: 200, statusText: 'OK', body: '{"ok":true}' };

/** React reads the value off the node, so the native setter has to be used. */
const type = (node: El, value: string): void => {
  const proto =
    node.tagName === 'TEXTAREA'
      ? browser.HTMLTextAreaElement.prototype
      : browser.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(node, value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
};

const formFor = (operationId: string): El => {
  const form = browser.document.querySelector(
    `form[data-try="${operationId}"]`,
  );
  if (form === null) throw new Error(`no form for ${operationId}`);
  return form;
};

const submit = async (form: El): Promise<void> => {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await Bun.sleep(40);
};

const text = (selector: string): string =>
  browser.document.querySelector(selector)?.textContent ?? '';

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://api.test/docs' });

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

  const page = renderPage(DOCUMENT, {
    jsonHref: '/openapi.json',
    warnings: ['one schema degraded'],
  });
  browser.document.write(page);

  // The bundle is the script that follows the model's. `lastIndexOf('<script>')`
  // would find react-dom's own `"<script>"` string literal instead.
  const marker = '</script><script>';
  const open = page.indexOf(marker) + marker.length;
  const script = page.slice(open, page.lastIndexOf('</script>'));
  // Running the page's own bundle is the entire point of this suite; there is
  // no other way to execute what `renderPage` serves.
  // oxlint-disable-next-line typescript/no-implied-eval
  new Function(script)();
  await Bun.sleep(120);
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe('the explorer, booted from the page it is inlined in', () => {
  it('renders the document it was handed, fetching nothing to do it', () => {
    expect(sent).toHaveLength(0);
    expect(text('h1')).toBe('Client');
    expect(browser.document.body.textContent).toContain('one schema degraded');
    expect(browser.document.body.textContent).toContain('/notes/{id}');
    expect(browser.document.body.textContent).toContain('One note');
  });

  it('gives every operation a disclosure control that reads as one', async () => {
    const controls = [
      ...browser.document.querySelectorAll('button.mantine-Accordion-control'),
    ];
    expect(controls.length).toBeGreaterThanOrEqual(2);
    expect(controls[0]?.getAttribute('aria-expanded')).toBe('false');
    controls[0]?.click();
    await Bun.sleep(20);
    expect(controls[0]?.getAttribute('aria-expanded')).toBe('true');
  });

  it('offers an Authorize dialog for the declared schemes', async () => {
    const button = [...browser.document.querySelectorAll('button')].find(
      (node) => (node.textContent ?? '').startsWith('Authorize'),
    );
    expect(button).toBeDefined();
    button?.click();
    await Bun.sleep(40);
    expect(
      browser.document.querySelector('[data-scheme="bearer"]'),
    ).not.toBeNull();
  });
});

describe('sending an operation', () => {
  it('substitutes a path parameter and appends a non-empty query', async () => {
    sent.length = 0;
    reply = { status: 200, statusText: 'OK', body: '{"id":7}' };

    const form = formFor('Notes_one');
    type(form.querySelector('[data-in="path"]') as El, '7');
    type(form.querySelector('[data-in="query"]') as El, 'author');
    await submit(form);

    // 7, not "{id}" - and the query only appears because it was filled in.
    expect(sent[0]?.url).toBe('http://api.test/notes/7?expand=author');
    expect(sent[0]?.method).toBe('GET');
    expect(sent[0]?.body).toBeUndefined();
    expect(form.closest('[data-operation]')?.textContent).toContain('200 OK');
  });

  it('leaves an empty query parameter out of the URL entirely', async () => {
    sent.length = 0;
    const form = formFor('Notes_one');
    type(form.querySelector('[data-in="path"]') as El, '9');
    type(form.querySelector('[data-in="query"]') as El, '   ');
    await submit(form);

    expect(sent[0]?.url).toBe('http://api.test/notes/9');
  });

  it('sends the schema-derived body with a JSON content type', async () => {
    sent.length = 0;
    reply = { status: 201, statusText: 'Created', body: '{"created":true}' };

    const form = formFor('Notes_create');
    // Untouched: what goes out is what `sampleFor` pre-filled.
    await submit(form);

    expect(sent[0]?.method).toBe('POST');
    expect(JSON.parse(sent[0]?.body ?? '')).toEqual({ memo: 'string' });
    expect(sent[0]?.headers['content-type']).toBe('application/json');
    // Pretty-printed, because the response said it was JSON.
    expect(form.closest('[data-operation]')?.textContent).toContain(
      '"created": true',
    );
  });

  it('parses the free-text header box, one Name: value per line', async () => {
    sent.length = 0;
    const form = formFor('Notes_create');
    type(form.querySelector('[data-headers]') as El, 'X-Trace: abc\nX-Two: 2');
    await submit(form);

    expect(sent[0]?.headers['X-Trace']).toBe('abc');
    expect(sent[0]?.headers['X-Two']).toBe('2');
  });

  it('applies a token typed once to every operation that declares the scheme', async () => {
    const field = browser.document.querySelector('[data-scheme="bearer"]');
    type(field as El, 't0ken');
    await Bun.sleep(20);

    sent.length = 0;
    await submit(formFor('Notes_one'));
    expect(sent[0]?.headers['Authorization']).toBe('Bearer t0ken');

    // Notes_create declares no security, so nothing is attached to it.
    sent.length = 0;
    await submit(formFor('Notes_create'));
    expect(sent[0]?.headers['Authorization']).toBeUndefined();
  });

  it('marks a rejected response as a failure rather than swallowing it', async () => {
    reply = {
      status: 400,
      statusText: 'Bad Request',
      body: '{"error":"nope"}',
    };
    const form = formFor('Notes_create');
    await submit(form);

    const panel = form.closest('[data-operation]');
    expect(panel?.textContent).toContain('400 Bad Request');
    expect(panel?.textContent).toContain('nope');
  });
});
