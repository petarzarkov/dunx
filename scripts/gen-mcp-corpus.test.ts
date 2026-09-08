import { describe, expect, it } from 'bun:test';
import { CORPUS_PATH, renderCorpus } from './gen-mcp-corpus.js';

/**
 * `tools/mcp/src/generated.ts` is committed, so a guide edit that never ran the
 * generator ships a corpus describing the previous release. Nothing else would
 * notice: the stale file compiles, passes its own tests, and answers confidently.
 */
describe('the bundled corpus', () => {
  it('matches what the generator renders from the sources today', async () => {
    const committed = await Bun.file(CORPUS_PATH).text();
    expect(committed).toBe(await renderCorpus());
  });

  it('carries every guide chapter', async () => {
    const { GUIDE } = await import('../tools/mcp/src/generated.js');
    const slugs: string[] = [];
    for await (const file of new Bun.Glob('*.md').scan({ cwd: 'docs/guide' })) {
      slugs.push(file.replace(/\.md$/, ''));
    }
    expect(GUIDE.map((doc) => doc.slug).sort()).toEqual(slugs.sort());
  });

  it('rewrites a chapter link to its resource uri and a repo link to an absolute one', async () => {
    const { GUIDE } = await import('../tools/mcp/src/generated.js');
    const bodies = GUIDE.map((doc) => doc.body).join('\n');
    expect(bodies).toContain('](dunx://guide/');
    expect(bodies).toContain(
      '](https://github.com/petarzarkov/dunx/blob/main/',
    );
    // A consumer has neither, so neither may survive into the corpus.
    expect(bodies).not.toContain('](./0');
    expect(bodies).not.toContain('](../');
  });

  it('takes the feature catalogue from create-app rather than restating it', async () => {
    const { FEATURES } = await import('../tools/create-app/src/features.js');
    const { SCAFFOLD } = await import('../tools/mcp/src/generated.js');
    expect(SCAFFOLD.map((feature) => feature.name)).toEqual(
      FEATURES.map((feature) => feature.name),
    );
  });

  it('takes the starter from examples/minimal, which CI boots', async () => {
    const { MINIMAL } = await import('../tools/mcp/src/generated.js');
    const paths = MINIMAL.files.map((file) => file.path);
    expect(paths).toContain('src/main.ts');
    expect(paths).toContain('src/app.module.ts');
    expect(paths).toContain('bunfig.toml');
    expect(paths).toContain('tsconfig.json');

    const main = MINIMAL.files.find((file) => file.path === 'src/main.ts');
    expect(main?.body).toBe(
      await Bun.file('examples/minimal/src/main.ts').text(),
    );
  });
});
