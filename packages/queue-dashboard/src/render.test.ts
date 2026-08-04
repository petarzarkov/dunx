import { afterEach, describe, expect, it } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ejsRenderer,
  loadBullBoard,
  substituteRenderer,
  TemplateSyntaxError,
} from './render.js';

/**
 * The substitution renderer replaces `ejs` for bull-board's entry template, so the
 * assertion that matters is not "it renders something" but **"it renders exactly what
 * ejs renders"** for the real file. `ejs` is a devDependency here purely so this
 * comparison can be made; it is not a runtime dependency of the package.
 */
const PARAMS = {
  basePath: '/queues/',
  title: 'dunx & co "queues"',
  favIconDefault: '/static/images/logo.svg?a=1&b=2',
  favIconAlternative: '/static/favicon-32x32.png',
  uiConfig: JSON.stringify({ boardTitle: 'x', misc: '<b>raw</b>' }),
};

/**
 * ejs and `Bun.escapeHTML` disagree on the *spelling* of two entities, not on which
 * characters they escape: ejs writes `&#34;` and `&#39;`, Bun writes `&quot;` and
 * `&#x27;`. Both decode to the same character in every parser, so equivalence is
 * asserted modulo that - and `<`, `>` and `&`, the ones that actually matter for
 * injection, are byte-identical either way.
 */
const normalise = (html: string): string =>
  html.replaceAll('&#34;', '&quot;').replaceAll('&#39;', '&#x27;');

const files: string[] = [];
const write = async (contents: string): Promise<string> => {
  const path = join(
    tmpdir(),
    `dunx-tpl-${files.length}-${contents.length}.ejs`,
  );
  await writeFile(path, contents);
  files.push(path);
  return path;
};

afterEach(async () => {
  for (const path of files.splice(0)) await rm(path, { force: true });
});

describe('substituteRenderer against ejs', () => {
  it('renders the real bull-board template the same as ejs does', async () => {
    const { uiPath } = await loadBullBoard();
    const view = `${uiPath}/index.ejs`;

    const mine = await substituteRenderer(view, PARAMS);
    const theirs = await (await ejsRenderer())(view, PARAMS);

    expect(normalise(mine)).toBe(normalise(theirs));
    // Same length once the entity spellings are reconciled, so nothing was dropped.
    expect(normalise(mine).length).toBe(normalise(theirs).length);
    // And the substitutions actually happened.
    expect(mine).toContain('<base href="/queues/" />');
    expect(mine).not.toContain('<%');
  });

  /** `<%=` escapes, `<%-` does not. Getting that backwards is an injection. */
  it('escapes <%= and leaves <%- raw, exactly as ejs does', async () => {
    const view = await write('<a>{<%= title %>}</a><b>{<%- uiConfig %>}</b>');
    const params = { title: '<script>&"x"', uiConfig: '{"a":"<b>"}' };

    const mine = await substituteRenderer(view, params);
    expect(normalise(mine)).toBe(
      normalise(await (await ejsRenderer())(view, params)),
    );
    // The characters that matter escape identically, spelling aside.
    expect(mine).toContain('&lt;script&gt;');
    expect(mine).toContain('&amp;');
    expect(mine).toContain('{"a":"<b>"}');
  });

  it('handles whitespace inside the tag the way ejs does', async () => {
    const view = await write('<%=title%>|<%=   title   %>|<%- title %>');
    const params = { title: 'v' };
    expect(normalise(await substituteRenderer(view, params))).toBe(
      normalise(await (await ejsRenderer())(view, params)),
    );
  });
});

describe('the params guard', () => {
  /** A name the handler stopped supplying is a contract change, not an empty string. */
  it('throws on an interpolation the params do not have', async () => {
    const view = await write('<%= somethingNew %>');
    const failure = await substituteRenderer(view, { title: 'x' }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TemplateSyntaxError);
    expect((failure as Error).message).toContain('somethingNew');
  });

  it('renders null and undefined as empty, as ejs does for null', async () => {
    const view = await write('[<%= nothing %>]');
    expect(await substituteRenderer(view, { nothing: null })).toBe('[]');
  });
});
