import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { StaticFiles } from './files.js';
import { normalizePrefix, StaticOptions } from './options.js';

/**
 * The traversal guard is the whole reason this class exists rather than a
 * two-line `new Response(Bun.file(...))`, so it is what the suite is about.
 */
let root = '';
let sibling = '';

beforeAll(async () => {
  root = join(tmpdir(), `dunx-static-${Bun.randomUUIDv7()}`);
  // A directory whose name *starts with the root's*, which is the case a naive
  // `startsWith(root)` check lets through.
  sibling = `${root}-secrets`;
  await mkdir(join(root, 'nested'), { recursive: true });
  await mkdir(sibling, { recursive: true });
  await writeFile(join(root, 'app.js'), 'export const a = 1;');
  await writeFile(join(root, 'nested', 'deep.css'), 'body{}');
  await writeFile(join(sibling, 'keys.txt'), 'do not serve me');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(sibling, { recursive: true, force: true });
});

const filesAt = (path = '/static'): StaticFiles =>
  new StaticFiles(new StaticOptions({ root, path }));

describe('normalizePrefix', () => {
  it('gives one leading slash and no trailing one', () => {
    expect(normalizePrefix('static')).toBe('/static');
    expect(normalizePrefix('/static/')).toBe('/static');
    expect(normalizePrefix('//a//b//')).toBe('/a/b');
  });

  it('keeps the root as the root', () => {
    expect(normalizePrefix('/')).toBe('/');
    expect(normalizePrefix('')).toBe('/');
  });
});

describe('resolvePath', () => {
  // Built per test, not in the describe body: that runs before `beforeAll`, so
  // `root` would still be '' and every path would resolve against the cwd.
  it('resolves a file under the root', () => {
    const files = filesAt();
    expect(files.resolvePath('/static/app.js')).toBe(join(root, 'app.js'));
    expect(files.resolvePath('/static/nested/deep.css')).toBe(
      join(root, 'nested', 'deep.css'),
    );
  });

  it('refuses a traversal', () => {
    const files = filesAt();
    expect(files.resolvePath('/static/../../etc/passwd')).toBeUndefined();
    expect(
      files.resolvePath('/static/nested/../../../etc/passwd'),
    ).toBeUndefined();
  });

  it('refuses a percent-encoded traversal', () => {
    const files = filesAt();
    // `%2e%2e%2f` survives normalisation as an opaque segment unless it is
    // decoded first, which is why decoding happens before the check.
    expect(
      files.resolvePath('/static/%2e%2e%2f%2e%2e%2fetc/passwd'),
    ).toBeUndefined();
  });

  it('refuses a sibling directory whose name starts with the root’s', () => {
    const files = filesAt();
    // The case a bare `startsWith(root)` lets through: /tmp/x and /tmp/x-secrets
    // share a prefix, so the comparison has to carry a separator.
    expect(
      files.resolvePath('/static/../dunx-static-x-secrets/keys.txt'),
    ).toBeUndefined();
  });

  it('refuses a NUL, which truncates a path in some syscalls', () => {
    const files = filesAt();
    expect(files.resolvePath('/static/app.js%00.png')).toBeUndefined();
  });

  it('refuses malformed percent-encoding rather than throwing', () => {
    const files = filesAt();
    expect(files.resolvePath('/static/%')).toBeUndefined();
  });
});

describe('handle', () => {
  const ctx = {} as never;
  const next = (): Promise<Response> =>
    Promise.resolve(new Response('fell through', { status: 404 }));
  const get = (url: string, files = filesAt()): Promise<Response> =>
    files.handle(new Request(url) as never, ctx, next);

  it('serves a file with a cache policy and nosniff', async () => {
    const response = await get('http://x.test/static/app.js');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('export const a = 1;');
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('falls through for anything outside the mount', async () => {
    // The app's own routes and its 404 behave exactly as before.
    expect((await get('http://x.test/api/notes')).status).toBe(404);
    // And a prefix that merely starts the same is not the mount.
    expect((await get('http://x.test/staticky/app.js')).status).toBe(404);
  });

  it('falls through for a missing file, rather than inventing a 404', async () => {
    const response = await get('http://x.test/static/nope.js');
    expect(await response.text()).toBe('fell through');
  });

  it('falls through for a traversal, so the root’s location stays unconfirmed', async () => {
    // Deliberately not 403: a distinct status is a signal about what is there.
    const response = await get('http://x.test/static/../../etc/passwd');
    expect(await response.text()).toBe('fell through');
  });

  it('claims immutable only for a name the caller vouched for', async () => {
    const hashed = new StaticFiles(
      new StaticOptions({
        root,
        path: '/static',
        immutable: (pathname) => pathname.endsWith('.js'),
      }),
    );
    const js = await get('http://x.test/static/app.js', hashed);
    expect(js.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
    const css = await get('http://x.test/static/nested/deep.css', hashed);
    expect(css.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('leaves a write alone', async () => {
    const files = filesAt();
    const response = await files.handle(
      new Request('http://x.test/static/app.js', { method: 'POST' }) as never,
      ctx,
      next,
    );
    expect(await response.text()).toBe('fell through');
  });
});
