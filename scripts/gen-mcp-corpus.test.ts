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
    const rendered = await renderCorpus();
    // Hashed rather than compared directly: the two are 440 KB each, and a failing
    // `toBe` prints both. The message is the actionable half.
    const digest = (text: string): string =>
      new Bun.CryptoHasher('sha256').update(text).digest('hex');
    expect(
      digest(committed) === digest(rendered)
        ? 'up to date'
        : 'stale - a source changed since the corpus was generated, run `bun run gen:mcp`',
    ).toBe('up to date');
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

  it('resolves a link against the chapter it is in, whatever its depth', async () => {
    const { rewriteLinks } = await import('./gen-mcp-corpus.js');
    const at = (from: string, md: string) => rewriteLinks(md, from);

    // A sibling, with and without the leading `./`, and with a fragment.
    expect(at('docs/guide/03-providers.md', '[a](./06-validation.md)')).toBe(
      '[a](dunx://guide/06-validation)',
    );
    expect(at('docs/guide/03-providers.md', '[a](06-validation.md)')).toBe(
      '[a](dunx://guide/06-validation)',
    );
    expect(at('docs/guide/03-providers.md', '[a](./06-validation.md#x)')).toBe(
      '[a](dunx://guide/06-validation#x)',
    );

    // A chapter one level down resolves from its own directory, not the corpus root.
    expect(at('docs/guide/deep/x.md', '[a](../06-validation.md)')).toBe(
      '[a](dunx://guide/06-validation)',
    );

    // Out of the corpus becomes absolute; absolute and fragments are untouched.
    expect(at('docs/guide/03-providers.md', '[a](../ARCHITECTURE.md)')).toBe(
      '[a](https://github.com/petarzarkov/dunx/blob/main/docs/ARCHITECTURE.md)',
    );
    expect(at('docs/guide/03-providers.md', '[a](https://x.dev)')).toBe(
      '[a](https://x.dev)',
    );
    expect(at('docs/guide/03-providers.md', '[a](#section)')).toBe(
      '[a](#section)',
    );
  });

  it('takes the feature catalogue from create-app rather than restating it', async () => {
    const { FEATURES } = await import('../tools/create-app/src/features.js');
    const { SCAFFOLD } = await import('../tools/mcp/src/generated.js');
    expect(SCAFFOLD.map((feature) => feature.name)).toEqual(
      FEATURES.map((feature) => feature.name),
    );
  });

  /**
   * `agents.ts` and `adopt.ts` each spelled out the boot-error rules for the same
   * audience and had already drifted to six against four.
   */
  it('takes the boot rules from create-app rather than restating them', async () => {
    const { BOOT_RULES } = await import('../tools/create-app/src/rules.js');
    const { RULES } = await import('../tools/mcp/src/generated.js');
    expect(RULES).toEqual(BOOT_RULES);
    expect(RULES.length).toBeGreaterThan(4);
  });

  /** `Same` collapses to `never` if either package changes the shape. */
  it('holds the two BootRule shapes to the same fields', async () => {
    const mod = await import('./gen-mcp-corpus.js');
    expect(mod.BOOT_RULE_SHAPES_AGREE).toBe(true);
  });

  it('renders those same rules into the scaffolded AGENTS.md', async () => {
    const { BOOT_RULES } = await import('../tools/create-app/src/rules.js');
    const { agentFiles } = await import('../tools/create-app/src/agents.js');
    const written = agentFiles('demo', [])['AGENTS.md'] ?? '';
    for (const { rule } of BOOT_RULES) expect(written).toContain(rule);
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
