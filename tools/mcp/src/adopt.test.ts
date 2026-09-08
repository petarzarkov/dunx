import { describe, expect, it } from 'bun:test';
import { adoptionResources, adoptionTools } from './adopt.js';
import { GUIDE, MINIMAL, RULES, SCAFFOLD } from './generated.js';
import { Guide, GUIDE_SCHEME, type GuideDoc } from './guide.js';
import { handle } from './protocol.js';
import { Scaffold, VERSION_PLACEHOLDER, type Starter } from './scaffold.js';

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

  /**
   * `docs/guide/` really does hold two chapters numbered 22, so `topic: "22"`
   * used to return the first of them and spend a whole chapter body on it.
   */
  it('refuses to guess when a substring matches several chapters', () => {
    const twins = new Guide([
      { ...docs[0]!, slug: '22-metrics', title: 'Metrics' },
      { ...docs[1]!, slug: '22-upgrading', title: 'Upgrading' },
    ]);
    expect(twins.chapter('22')).toBeUndefined();
    expect(twins.candidates('22')).toEqual(['22-metrics', '22-upgrading']);
    // An exact slug is still answered.
    expect(twins.chapter('22-upgrading')?.title).toBe('Upgrading');
  });

  /**
   * `search` is literal, so a question written as a sentence matched no line in any
   * chapter and answered `hits: []` with nowhere to go. These are the words a
   * caller actually types.
   */
  it('suggests the chapter a sentence points at, though no line matches it', () => {
    const result = guide.search('how do I validate a request body');
    expect(result.hits).toEqual([]);
    expect(result.suggested[0]).toBe('06-validation');
  });

  /**
   * `validate` is not a substring of `Validation` in either direction, which is why
   * the words are compared five characters at a time.
   */
  it('matches a word against the form the chapter title uses', () => {
    expect(guide.suggest('validating')[0]).toBe('06-validation');
    expect(guide.suggest('validation')[0]).toBe('06-validation');
  });

  /**
   * Every chapter mentions `route` somewhere, so scoring bodies alone ranked the
   * whole guide against any query and the tail was guide order wearing a score. A
   * chapter has to name the subject in its title, a heading or its summary to be
   * suggested at all; the body only breaks ties between those.
   */
  it('does not suggest a chapter that only mentions the word in passing', () => {
    // `zod` is in both fixture bodies and in neither title, heading or summary.
    expect(guide.suggest('zod')).toEqual([]);
    // Named in a heading, so the body's two mentions now count.
    const named = new Guide([docs[0]!, { ...docs[1]!, sections: ['zod'] }]);
    expect(named.suggest('zod')).toEqual(['06-validation']);
  });

  it('scores nothing when the query is all stopwords or punctuation', () => {
    expect(guide.suggest('how do I')).toEqual([]);
    expect(guide.suggest('   ...   ')).toEqual([]);
    expect(guide.search('how do I').suggested).toEqual([]);
  });

  it('caps the suggestions rather than ranking the whole guide', () => {
    const many = new Guide(
      Array.from({ length: 12 }, (_, index) => ({
        ...docs[1]!,
        slug: `${index}-chapter`,
        title: 'Validation',
      })),
    );
    expect(many.suggest('validation')).toHaveLength(5);
  });

  it('treats a blank topic as no topic rather than as a match on everything', () => {
    expect(guide.chapter('   ')).toBeUndefined();
    expect(guide.candidates('  ')).toEqual([]);
  });

  it('names every candidate, so an ambiguous topic is answerable', () => {
    expect(guide.candidates('0')).toEqual(['01-introduction', '06-validation']);
    expect(guide.candidates('nothing')).toEqual([]);
  });

  it('searches lines rather than chapters, and reports what it left out', () => {
    const { hits, omitted } = guide.search('zod');
    expect(hits).toHaveLength(3);
    expect(omitted).toBe(0);
    expect(hits[0]).toEqual({
      slug: '01-introduction',
      line: 3,
      text: 'A line about zod.',
    });

    const capped = guide.search('zod', 1);
    expect(capped.hits).toHaveLength(1);
    expect(capped.omitted).toBe(2);
  });

  /**
   * A flat cap was spent inside the first chapter, so a common word never reached
   * the chapter that answers the question.
   */
  it('caps hits per chapter so a later chapter is still reachable', () => {
    const noisy = new Guide([
      {
        slug: '01-introduction',
        title: 'Introduction',
        summary: '',
        sections: [],
        body: Array.from({ length: 40 }, () => 'zod').join('\n'),
      },
      {
        slug: '06-validation',
        title: 'Validation',
        summary: '',
        sections: [],
        body: 'zod lives here\n',
      },
    ]);
    const { hits, omitted } = noisy.search('zod');
    expect(hits.filter((hit) => hit.slug === '01-introduction')).toHaveLength(
      5,
    );
    expect(hits.some((hit) => hit.slug === '06-validation')).toBe(true);
    expect(omitted).toBe(35);
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

  /**
   * A caller asks for a capability and the catalogue is keyed by folder, so
   * `queue` found nothing while `jobs` was described as "bullmq queues over
   * Bun.RedisClient". `redis` found nothing either, against four features that
   * need one.
   */
  it('matches the summary as well as the name', () => {
    expect(scaffold.features('redis').map((f) => f.name)).toEqual(['cache']);
    expect(scaffold.features('crud').map((f) => f.name)).toEqual(['notes']);
  });

  it('finds the real catalogue by what a feature does, not what it is called', () => {
    const real = new Scaffold(SCAFFOLD, MINIMAL);
    expect(real.features('queue').map((f) => f.name)).toContain('jobs');
    expect(real.features('rate limit').map((f) => f.name)).toContain(
      'throttle',
    );
  });

  it('returns the starter as given when it holds no placeholder', () => {
    // Content, not identity: `starter()` maps the file list to resolve
    // `VERSION_PLACEHOLDER`, so the object is a new one either way.
    expect(scaffold.starter()).toEqual(starter);
  });

  /**
   * The corpus stores the placeholder because it is committed and the release job
   * bumps every manifest after it was generated. Resolving on the way out is what
   * keeps a published starter from pinning the previous release.
   */
  it('resolves the version placeholder when it serves the starter', () => {
    const pinned = new Scaffold(
      [],
      {
        ...starter,
        files: [
          {
            path: 'package.json',
            body: `{"dependencies":{"@dunx/core":"${VERSION_PLACEHOLDER}"}}`,
          },
        ],
      },
      '9.9.9',
    );
    const body = pinned.starter().files[0]?.body ?? '';
    expect(body).toContain('"9.9.9"');
    expect(body).not.toContain(VERSION_PLACEHOLDER);
  });

  it('defaults the version to the one this package reports', async () => {
    const own = Bun.file(`${import.meta.dir}/../package.json`);
    const { version } = (await own.json()) as { version: string };
    const pinned = new Scaffold([], {
      ...starter,
      files: [{ path: 'package.json', body: VERSION_PLACEHOLDER }],
    });
    expect(pinned.starter().files[0]?.body).toBe(version);
  });

  it('builds the install steps out of the starter manifest', () => {
    const steps = scaffold.steps();
    expect(steps).toHaveLength(2);
    expect(steps[0]?.run).toBe('bun add @dunx/core');
    expect(steps[1]?.run).toBe('bun add -d @dunx/testing');
  });

  /** `bun add ` with nothing after it is a command an agent would run. */
  it('omits an install step rather than emitting a bare bun add', () => {
    const bare = new Scaffold([], {
      ...starter,
      dependencies: [],
      devDependencies: [],
    });
    expect(bare.steps()).toEqual([]);

    const devOnly = new Scaffold([], { ...starter, dependencies: [] });
    expect(devOnly.steps().map((step) => step.run)).toEqual([
      'bun add -d @dunx/testing',
    ]);
  });

  /**
   * It used to be a third step: `echo 'preload = [...]' >> bunfig.toml`. An append
   * writes a bare key onto the end of the file, so a bunfig ending inside a table
   * takes the key into that table and the top-level preload never applies.
   */
  it('hands over the bunfig file rather than a command that appends to it', () => {
    const withBunfig = new Scaffold([], {
      ...starter,
      files: [
        {
          path: 'bunfig.toml',
          body: 'preload = ["@dunx/transform/preload"]\n',
        },
      ],
    });
    expect(withBunfig.bunfig()).toMatchObject({ path: 'bunfig.toml' });
    expect(withBunfig.bunfig()?.contents).toContain('@dunx/transform/preload');
    for (const step of withBunfig.steps()) expect(step.run).not.toContain('>>');
    // Absent from the starter is answerable rather than a crash.
    expect(scaffold.bunfig()).toBeUndefined();
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
    const adopt = start['addToExistingProject'] as {
      commands: unknown[];
      bunfig: { contents: string };
    };
    expect(adopt.commands).toHaveLength(2);
    // Both the top-level preload and the `[test]` copy, which the old shell
    // append never wrote.
    expect(adopt.bunfig.contents).toContain(
      'preload = ["@dunx/transform/preload"]',
    );
    expect(adopt.bunfig.contents).toContain('[test]');
    expect(start['rules']).toHaveLength(RULES.length);
    expect(start['guide']).toHaveLength(GUIDE.length);
  });

  /**
   * The payload a client pays for on every session. It was 17 KB before
   * `dunx_start` stopped embedding each chapter's summary and section headings.
   */
  it('keeps dunx_start under 6 KB', async () => {
    expect(JSON.stringify(await call('dunx_start')).length).toBeLessThan(6144);
  });

  it('states the real chapter count in the description a model reads', () => {
    expect(tool('dunx_guide').description).toContain(
      `${GUIDE.length} chapters`,
    );
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
    expect(search['omitted']).toBeNumber();

    // Both given is answerable rather than silently dropping one of them.
    const both = await call('dunx_guide', {
      search: 'zod',
      topic: 'validation',
    });
    expect(both['note']).toContain('topic');

    const miss = await call('dunx_guide', { topic: 'kubernetes' });
    expect(miss['error']).toContain('kubernetes');
    expect(miss['chapters']).toContain('01-introduction');

    // Every chapter is numbered uniquely, so a full number is one chapter.
    const numbered = (await call('dunx_guide', { topic: '22' }))['chapter'] as {
      slug: string;
    };
    expect(numbered.slug).toBe('22-metrics');

    // A partial number is not, and the answer names them rather than picking one.
    const ambiguous = await call('dunx_guide', { topic: '2' });
    expect(ambiguous['error']).toContain('matches');
    expect((ambiguous['candidates'] as string[]).length).toBeGreaterThan(1);

    // Whitespace is not a topic, so it falls through to the index.
    expect(await call('dunx_guide', { topic: '   ' })).toHaveProperty(
      'chapters',
    );
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
      addToExistingProject: { bunfig: { contents: string } };
    };
    expect(start.addToExistingProject.bunfig.contents).toBe(bunfig);
  });

  it('installs what the minimal example depends on, and nothing else', async () => {
    const manifest = (await Bun.file(
      `${REPO}/examples/minimal/package.json`,
    ).json()) as { dependencies: Record<string, string> };
    expect(MINIMAL.dependencies).toEqual(Object.keys(manifest.dependencies));
  });
});
