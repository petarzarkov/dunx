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

  /**
   * The starter shipped seven files and no manifest, so an agent following it had
   * to invent the one file where a wrong guess is silent: without
   * `"type": "module"` every relative import in those five files fails to resolve.
   */
  it('ships a manifest, and one a consumer can install', async () => {
    const { MINIMAL } = await import('../tools/mcp/src/generated.js');
    const file = MINIMAL.files.find((entry) => entry.path === 'package.json');
    expect(file).toBeDefined();

    const manifest = JSON.parse(file?.body ?? '{}') as {
      type?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.type).toBe('module');
    expect(manifest.scripts?.['typecheck']).toBe('tsc --noEmit');

    // No `workspace:*` survives: the example resolves those from this repo and a
    // consumer installing one gets an unresolvable specifier.
    const ranges = [
      ...Object.values(manifest.dependencies ?? {}),
      ...Object.values(manifest.devDependencies ?? {}),
    ];
    expect(ranges).not.toContain('workspace:*');
  });

  /**
   * The corpus is committed and `scripts/version.ts` bumps every manifest after it
   * was generated, so a version written into the starter ships a release behind:
   * 3.5.1 would have handed an agent a starter pinning 3.5.0, and this file's own
   * drift test would have failed on the next push to main.
   */
  it('stores the version as a placeholder, so a release cannot stale it', async () => {
    const { MINIMAL } = await import('../tools/mcp/src/generated.js');
    const { Scaffold, VERSION_PLACEHOLDER } =
      await import('../tools/mcp/src/scaffold.js');
    const { SCAFFOLD } = await import('../tools/mcp/src/generated.js');
    const body = (starter: {
      files: readonly { path: string; body: string }[];
    }) =>
      starter.files.find((file) => file.path === 'package.json')?.body ?? '{}';

    const stored = JSON.parse(body(MINIMAL)) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // No `@dunx/*` range is a concrete version, whichever list it is in.
    const dunx = [
      ...Object.entries(stored.dependencies ?? {}),
      ...Object.entries(stored.devDependencies ?? {}),
    ].filter(([name]) => name.startsWith('@dunx/'));
    expect(dunx.length).toBeGreaterThan(0);
    for (const [, range] of dunx) expect(range).toBe(VERSION_PLACEHOLDER);

    // Served, it is this release's version and no placeholder survives.
    const own = (await Bun.file('tools/mcp/package.json').json()) as {
      version: string;
    };
    const served = new Scaffold(SCAFFOLD, MINIMAL).starter();
    const resolved = JSON.parse(body(served)) as {
      dependencies?: Record<string, string>;
    };
    expect(resolved.dependencies?.['@dunx/core']).toBe(own.version);
    for (const file of served.files) {
      expect(file.body).not.toContain(VERSION_PLACEHOLDER);
    }
  });

  /**
   * Two packages spell the same placeholder for the same reason and neither can
   * import the other's: `@dunx/create-app` exports its own as public API, and
   * `@dunx/mcp` must not gain a runtime dependency on create-app - bundling the
   * corpus is what avoids reaching outside the package at all.
   */
  it('spells the placeholder the same way create-app does', async () => {
    const mcp = await import('../tools/mcp/src/scaffold.js');
    const createApp = await import('../tools/create-app/src/scaffold.js');
    expect(mcp.VERSION_PLACEHOLDER).toBe(createApp.VERSION_PLACEHOLDER);
  });

  /**
   * The base `tsconfig.json` declares `types: ["bun"]`, so a starter without
   * `@types/bun` fails its first `tsc --noEmit` with TS2688. It did, and the
   * example's own manifest cannot say so - the workspace root supplies it there.
   */
  it('gives the starter the toolchain its tsconfig needs', async () => {
    const { MINIMAL } = await import('../tools/mcp/src/generated.js');
    const { DEV_TOOLCHAIN } =
      await import('../tools/create-app/src/generate.js');
    const manifest = JSON.parse(
      MINIMAL.files.find((entry) => entry.path === 'package.json')?.body ??
        '{}',
    ) as { devDependencies?: Record<string, string> };

    for (const [name, range] of Object.entries(DEV_TOOLCHAIN)) {
      expect(manifest.devDependencies?.[name]).toBe(range);
      // And in the list `Scaffold.steps()` renders `bun add -d` from, or an
      // existing project adopting dunx installs the tsconfig but not its types.
      expect(MINIMAL.devDependencies).toContain(name);
    }
  });

  /**
   * Two chapters numbered 22 made `topic: "22"` ambiguous. `Guide.chapter` answers
   * that with candidates rather than a coin flip, so this is the other half: the
   * numbering itself stays unique.
   */
  it('numbers every chapter exactly once', async () => {
    const { GUIDE } = await import('../tools/mcp/src/generated.js');
    const numbers = GUIDE.map((doc) => /^(\d+)-/.exec(doc.slug)?.[1]);
    expect(numbers.filter((number) => number === undefined)).toEqual([]);
    expect([...new Set(numbers)]).toHaveLength(numbers.length);
  });
});
