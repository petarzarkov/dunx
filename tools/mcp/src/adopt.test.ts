import { describe, expect, it } from 'bun:test';
import { adoptionResources, adoptionTools } from './adopt.js';
import { GUIDE, MINIMAL, SCAFFOLD } from './generated.js';
import { Guide, GUIDE_SCHEME, type GuideDoc } from './guide.js';
import { handle } from './protocol.js';
import { Scaffold, type Starter } from './scaffold.js';

const REPO = `${import.meta.dir}/../../..`;

const tool = (name: string) => {
  const found = adoptionTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};

const call = async (name: string, args: Record<string, unknown> = {}) =>
  (await tool(name).run(args)) as Record<string, unknown>;

const docs: readonly GuideDoc[] = [
  {
    slug: '01-introduction',
    title: 'Introduction',
    summary: 'What dunx is.',
    sections: ['Why', 'How'],
    body: '# Introduction\n\nA line about zod.\nAnother line about zod.\n',
  },
  {
    slug: '06-validation',
    title: 'Validation',
    summary: 'Route schemas.',
    sections: ['RouteSchemas'],
    body: '# Validation\n\nzod is the default.\n',
  },
];

describe('the guide reader', () => {
  const guide = new Guide(docs);

  it('indexes every chapter with a resource uri and no body', () => {
    const index = guide.index();
    expect(index).toHaveLength(2);
    expect(index[0]?.uri).toBe(`${GUIDE_SCHEME}01-introduction`);
    expect(index[0]).not.toHaveProperty('body');
  });

  it('reduces to slug and title for the start payload', () => {
    expect(guide.titles()).toEqual([
      { slug: '01-introduction', title: 'Introduction' },
      { slug: '06-validation', title: 'Validation' },
    ]);
  });

  it('finds a chapter by exact slug, by partial slug and by title', () => {
    expect(guide.chapter('06-validation')?.slug).toBe('06-validation');
    expect(guide.chapter('validation')?.slug).toBe('06-validation');
    expect(guide.chapter('Introduction')?.slug).toBe('01-introduction');
    expect(guide.chapter('queues')).toBeUndefined();
  });

  it('names every candidate, so an ambiguous topic is answerable', () => {
    expect(guide.candidates('0')).toEqual(['01-introduction', '06-validation']);
    expect(guide.candidates('nothing')).toEqual([]);
  });

  it('searches lines rather than chapters, and stops at the limit', () => {
    const hits = guide.search('zod');
    expect(hits).toHaveLength(3);
    expect(hits[0]).toEqual({
      slug: '01-introduction',
      line: 3,
      text: 'A line about zod.',
    });
    expect(guide.search('zod', 1)).toHaveLength(1);
  });

  it('serves each chapter as a markdown resource', () => {
    const resources = guide.resources();
    expect(resources).toHaveLength(2);
    expect(resources[1]?.uri).toBe(`${GUIDE_SCHEME}06-validation`);
    expect(resources[1]?.mimeType).toBe('text/markdown');
    expect(resources[1]?.read()).toContain('zod is the default');
  });
});

describe('the scaffold reader', () => {
  const starter: Starter = {
    runtime: 'bun >=1.4.1',
    dependencies: ['@dunx/core'],
    devDependencies: ['@dunx/testing'],
    files: [{ path: 'src/main.ts', body: 'export {};' }],
  };
  const scaffold = new Scaffold(
    [
      { name: 'notes', summary: 'CRUD.', requires: [], dependencies: [] },
      {
        name: 'cache',
        summary: 'Redis.',
        requires: [],
        dependencies: [],
        service: 'Redis or Valkey',
      },
    ],
    starter,
  );

  it('returns everything when no name is given, and filters when one is', () => {
    expect(scaffold.features()).toHaveLength(2);
    expect(scaffold.features('cach').map((f) => f.name)).toEqual(['cache']);
    expect(scaffold.features('nope')).toEqual([]);
  });

  it('returns the starter as given', () => {
    expect(scaffold.starter()).toBe(starter);
  });

  it('builds the install steps out of the starter manifest', () => {
    const steps = scaffold.steps();
    expect(steps[0]?.run).toBe('bun add @dunx/core');
    expect(steps[1]?.run).toBe('bun add -d @dunx/testing');
    expect(steps[2]?.run).toContain('@dunx/transform/preload');
  });
});

describe('the tools that need no app', () => {
  it('offers exactly the three, and every one of them is filter-only', () => {
    expect(adoptionTools().map((entry) => entry.name)).toEqual([
      'dunx_start',
      'dunx_guide',
      'dunx_scaffold',
    ]);
    for (const entry of adoptionTools()) {
      expect(entry.inputSchema['type']).toBe('object');
      expect(entry.description.length).toBeGreaterThan(80);
    }
  });

  it('answers dunx_start with the runtime, both routes in, and the rules', async () => {
    const start = await call('dunx_start');
    expect(start['runtime']).toBe(MINIMAL.runtime);
    expect(start['scaffold']).toMatchObject({
      command: 'bunx @dunx/create-app my-api',
    });
    expect(start['addToExistingProject']).toHaveLength(3);
    expect(start['rules']).toHaveLength(4);
    expect(start['guide']).toHaveLength(GUIDE.length);
  });

  /**
   * The payload a client pays for on every session. It was 17 KB before
   * `dunx_start` stopped embedding each chapter's summary and section headings.
   */
  it('keeps dunx_start under 6 KB', async () => {
    expect(JSON.stringify(await call('dunx_start')).length).toBeLessThan(6144);
  });

  it('answers dunx_guide with the index, a chapter, a search, and a miss', async () => {
    const index = (await call('dunx_guide'))['chapters'] as unknown[];
    expect(index).toHaveLength(GUIDE.length);

    const chapter = (await call('dunx_guide', { topic: 'validation' }))[
      'chapter'
    ] as GuideDoc;
    expect(chapter.slug).toBe('06-validation');
    expect(chapter.body).toContain('# Validation');

    const search = await call('dunx_guide', { search: 'RouteSchemas' });
    expect((search['hits'] as unknown[]).length).toBeGreaterThan(0);

    const miss = await call('dunx_guide', { topic: 'kubernetes' });
    expect(miss['error']).toContain('kubernetes');
    expect(miss['chapters']).toContain('01-introduction');
  });

  it('answers dunx_scaffold with the catalogue, and the starter only when asked', async () => {
    const all = await call('dunx_scaffold');
    expect((all['features'] as unknown[]).length).toBe(SCAFFOLD.length);
    expect(all['starter']).toBeUndefined();

    const withStarter = await call('dunx_scaffold', {
      feature: 'auth',
      starter: true,
    });
    expect((withStarter['features'] as { name: string }[])[0]?.name).toBe(
      'auth',
    );
    expect(withStarter['starter']).toMatchObject({ runtime: MINIMAL.runtime });
  });

  it('serves every chapter as a resource', () => {
    expect(adoptionResources()).toHaveLength(GUIDE.length);
  });

  /**
   * The generator rewrites a chapter link to `dunx://guide/<slug>`, keeping any
   * `#section` on it. Six of the twenty-five links carried one and `resources/read`
   * matched exactly, so following one answered `Unknown resource`.
   */
  it('reads every chapter link the corpus contains', async () => {
    const linked = new Set<string>();
    // Only a markdown link. The agent-tooling chapter names the scheme in prose,
    // and `dunx://guide/<slug>` is not something anything should resolve.
    for (const doc of GUIDE) {
      for (const match of doc.body.matchAll(
        /\]\((dunx:\/\/guide\/[^)\s]+)\)/g,
      )) {
        if (match[1] !== undefined) linked.add(match[1]);
      }
    }

    expect(linked.size).toBeGreaterThan(0);
    // The fragment case has to be present, or this asserts nothing.
    expect([...linked].some((uri) => uri.includes('#'))).toBe(true);

    const unreadable: string[] = [];
    for (const uri of linked) {
      const line = await handle(
        { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } },
        [],
        { name: '@dunx/mcp', version: '0.0.0' },
        adoptionResources(),
      );
      if (
        (JSON.parse(line ?? '{}') as { error?: unknown }).error !== undefined
      ) {
        unreadable.push(uri);
      }
    }
    expect(unreadable).toEqual([]);
  });
});

/**
 * `dunx_start`'s rules are prose, so nothing compiles them. Each one is checked
 * against the file that makes it true, or it rots into advice that used to be.
 */
describe('the rules dunx_start states', () => {
  it('quotes the preload line the base template actually writes', async () => {
    const bunfig = await Bun.file(
      `${REPO}/tools/create-app/templates/base/_bunfig.toml`,
    ).text();
    expect(bunfig).toContain('preload = ["@dunx/transform/preload"]');

    const start = (await call('dunx_start')) as {
      addToExistingProject: { run: string }[];
    };
    expect(start.addToExistingProject[2]?.run).toContain(
      'preload = ["@dunx/transform/preload"]',
    );
  });

  it('installs what the minimal example depends on, and nothing else', async () => {
    const manifest = (await Bun.file(
      `${REPO}/examples/minimal/package.json`,
    ).json()) as { dependencies: Record<string, string> };
    expect(MINIMAL.dependencies).toEqual(Object.keys(manifest.dependencies));
  });
});
