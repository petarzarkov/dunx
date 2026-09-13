import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EmailPreview } from './preview.js';
import { page } from './preview-page.js';
import { BodyRenderer, TemplateDir } from './templates.fixture.js';
import { discoverTemplates, loadTemplate } from './templates.js';

let dir: TemplateDir;

beforeEach(async () => {
  dir = await TemplateDir.create();
});

afterEach(() => dir.remove());

const preview = (): EmailPreview =>
  new EmailPreview({ dir: dir.path, renderer: new BodyRenderer(), port: 0 });

describe('discoverTemplates', () => {
  it('is empty for a directory with nothing in it', async () => {
    expect(await discoverTemplates(dir.path)).toEqual([]);
  });

  it('names a template by its path without the extension, sorted', async () => {
    await dir.template('welcome.ts', 'W');
    await dir.template('invite.tsx', 'I');
    await dir.template('nested/reset.ts', 'R');

    expect((await discoverTemplates(dir.path)).map((t) => t.name)).toEqual([
      'invite',
      'nested/reset',
      'welcome',
    ]);
  });

  // Everything a template directory holds that is not a template: shared
  // styles, a barrel, a suite, and the private helper beside them.
  it('skips suites, barrels, dotfiles and underscored files', async () => {
    await dir.template('welcome.ts', 'W');
    await dir.template('index.ts', 'X');
    await dir.template('welcome.test.ts', 'X');
    await dir.template('_styles.ts', 'X');
    await dir.template('nested/index.tsx', 'X');
    await dir.write('notes.md', 'not a module');

    expect((await discoverTemplates(dir.path)).map((t) => t.name)).toEqual([
      'welcome',
    ]);
  });
});

describe('loadTemplate', () => {
  it('is the default export', async () => {
    const file = await dir.template('welcome.ts', 'W');

    expect(await loadTemplate(file)).toEqual({ body: 'W' });
  });

  it('says which file has no default export', async () => {
    const file = await dir.write('empty.ts', 'export const a = 1;\n');

    await expect(loadTemplate(file)).rejects.toThrow(/no default export/);
  });
});

describe('EmailPreview', () => {
  it('renders one template with the renderer own preview props', async () => {
    await dir.template('welcome.ts', 'Hi');

    const rendered = await preview().render('welcome');

    expect(rendered.html).toBe('<p>Hi!</p>');
    expect(rendered.text).toBe('Hi!');
  });

  it('names a template it does not have', async () => {
    await expect(preview().render('nope')).rejects.toThrow(
      'No template named "nope".',
    );
  });

  it('exports every template, keeping the nesting', async () => {
    await dir.template('welcome.ts', 'W');
    await dir.template('nested/reset.ts', 'R');
    const out = await TemplateDir.create();

    const written = await preview().export(out.path);

    expect(written).toHaveLength(2);
    expect(await Bun.file(`${out.path}/welcome.html`).text()).toBe('<p>W!</p>');
    expect(await Bun.file(`${out.path}/nested/reset.html`).text()).toBe(
      '<p>R!</p>',
    );
    await out.remove();
  });
});

describe('EmailPreview.serve', () => {
  it('lists the templates on the index and frames the first', async () => {
    await dir.template('welcome.ts', 'W');
    await dir.template('invite.ts', 'I');
    const server = preview().serve();

    const body = await (await fetch(server.url)).text();

    expect(body).toContain('>invite</a>');
    expect(body).toContain('>welcome</a>');
    expect(body).toContain('src="/preview?tpl=invite"');
    await server.stop(true);
  });

  it('frames the template the query names', async () => {
    await dir.template('welcome.ts', 'W');
    await dir.template('invite.ts', 'I');
    const server = preview().serve();

    const body = await (
      await fetch(new URL('/?tpl=welcome', server.url))
    ).text();

    expect(body).toContain('src="/preview?tpl=welcome"');
    await server.stop(true);
  });

  it('serves the html and the plain text of one template', async () => {
    await dir.template('welcome.ts', 'Hi');
    const server = preview().serve();

    const html = await fetch(new URL('/preview?tpl=welcome', server.url));
    const text = await fetch(new URL('/text?tpl=welcome', server.url));

    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await html.text()).toBe('<p>Hi!</p>');
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await text.text()).toBe('Hi!');
    await server.stop(true);
  });

  // The cache-busting import is the whole of live reload: without it the second
  // request serves the module Bun already executed.
  it('picks up an edit without a restart', async () => {
    await dir.template('welcome.ts', 'First');
    const server = preview().serve();
    const url = new URL('/preview?tpl=welcome', server.url);

    expect(await (await fetch(url)).text()).toBe('<p>First!</p>');
    await dir.template('welcome.ts', 'Second');

    expect(await (await fetch(url)).text()).toBe('<p>Second!</p>');
    await server.stop(true);
  });

  it('answers a render failure with the stack rather than a blank frame', async () => {
    await dir.write('broken.ts', 'throw new Error("boom");\n');
    const server = preview().serve();

    const response = await fetch(new URL('/preview?tpl=broken', server.url));

    expect(response.status).toBe(500);
    expect(await response.text()).toContain('boom');
    await server.stop(true);
  });

  it('refuses a request that names no template', async () => {
    const server = preview().serve();

    const response = await fetch(new URL('/preview', server.url));

    expect(response.status).toBe(400);
    await server.stop(true);
  });

  it('404s a path it does not serve', async () => {
    const server = preview().serve();

    expect((await fetch(new URL('/nope', server.url))).status).toBe(404);
    await server.stop(true);
  });

  it('takes a hostname when it is given one', async () => {
    const server = new EmailPreview({
      dir: dir.path,
      renderer: new BodyRenderer(),
      port: 0,
      hostname: '127.0.0.1',
    }).serve();

    expect(server.hostname).toBe('127.0.0.1');
    await server.stop(true);
  });
});

describe('the preview page', () => {
  it('says so when there is nothing to show', () => {
    expect(page([])).toContain('no templates');
  });

  it('escapes a template name into the markup', () => {
    expect(page(['<script>'])).toContain('&lt;script&gt;');
  });

  it('marks the selected link active', () => {
    expect(page(['a', 'b'], 'b')).toContain('href="/?tpl=b" class="active"');
  });
});
