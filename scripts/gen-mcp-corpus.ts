/**
 * Writes `tools/mcp/src/generated.ts`: the written guide, the smallest working app,
 * and the catalogue `bunx @dunx/create-app` scaffolds from.
 *
 * `@dunx/mcp` answers adoption questions before there is an app to read, so the
 * answers have to travel inside the published package - `docs/guide/` and
 * `examples/minimal/` are outside it and `files` cannot reach them. Committed
 * rather than generated at publish time, and rewritten by `bun run gen:mcp`, so a
 * source checkout works with no build step and a diff shows what a consumer
 * receives. Same arrangement as `packages/dashboard/src/ui-bundle.ts`, except that
 * `build` does not run this: it is the first phase of `bun run ci`, so a build
 * that regenerated the corpus left the drift test comparing a file written
 * seconds earlier.
 *
 * Every input is something CI already builds, boots or tours, so nothing here can
 * describe a template that stopped working.
 */
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURES } from '../tools/create-app/src/features.js';
import { DEV_TOOLCHAIN } from '../tools/create-app/src/generate.js';
import { BOOT_RULES } from '../tools/create-app/src/rules.js';
import type { BootRule as CreateAppBootRule } from '../tools/create-app/src/rules.js';
import { summaryOf } from './guide-summary.js';
import type { GuideDoc } from '../tools/mcp/src/guide.js';
import type {
  BootRule,
  ScaffoldFeature,
  Starter,
  StarterFile,
} from '../tools/mcp/src/scaffold.js';

// `fileURLToPath` rather than `.pathname`, which leaves a space as `%20` and
// makes every read below fail on a checkout path that has one.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BLOB = 'https://github.com/petarzarkov/dunx/blob/main';
/** Where a chapter's own relative links resolve from. */
const GUIDE_DIR = 'docs/guide';
const OUT = join(ROOT, 'tools/mcp/src/generated.ts');

/**
 * A chapter link becomes its resource URI, so a client following one stays in the
 * corpus. Everything else is a repo path the consumer does not have, so it becomes
 * an absolute link.
 *
 * The href is resolved against the chapter's directory and the decision is made on
 * the resolved path. It used to be ordered regex replacement, `../../` before
 * `../` so the second pattern did not eat the first half of the first, which was
 * correct only while every chapter sat at exactly `docs/guide/*.md`.
 */
export const rewriteLinks = (markdown: string, from: string): string =>
  // Any href that is not absolute, not a fragment and not root-relative, which
  // covers `./x.md`, `../../x` and a bare `x.md`. Matching only a leading `.`
  // left a bare sibling link pointing at a path the consumer does not have.
  markdown.replace(
    /\]\((?!https?:|mailto:|#|\/)([^)\s]+)/g,
    (whole: string, href: string) => {
      // Against the directory of the chapter being rewritten, not a constant. A
      // chapter one level down would otherwise resolve its links as if it sat
      // beside its siblings.
      const target = posix.normalize(posix.join(posix.dirname(from), href));
      const chapter = /^docs\/guide\/([^/]+)\.md(#.*)?$/i.exec(target);
      if (chapter) return `](dunx://guide/${chapter[1]}${chapter[2] ?? ''}`;
      // Outside the corpus and outside the repo layout it knows: leave it be
      // rather than inventing a blob URL for it.
      return target.startsWith('..') ? whole : `](${BLOB}/${target}`;
    },
  );

const readGuide = async (): Promise<readonly GuideDoc[]> => {
  const dir = join(ROOT, 'docs/guide');
  const slugs: string[] = [];
  for await (const file of new Bun.Glob('*.md').scan({ cwd: dir })) {
    slugs.push(file.replace(/\.md$/, ''));
  }
  slugs.sort();

  const docs: GuideDoc[] = [];
  for (const slug of slugs) {
    const source = `${GUIDE_DIR}/${slug}.md`;
    const body = rewriteLinks(
      await Bun.file(join(dir, `${slug}.md`)).text(),
      source,
    );
    const lines = body.split('\n');
    docs.push({
      slug,
      title:
        lines
          .find((line) => line.startsWith('# '))
          ?.slice(2)
          .trim() ?? slug,
      summary: summaryOf(body),
      sections: lines
        .filter((line) => line.startsWith('## '))
        .map((line) => line.slice(3).trim()),
      body,
    });
  }
  return docs;
};

/**
 * The manifest the starter is written with.
 *
 * `examples/minimal/package.json` is a workspace manifest: its `@dunx/*` ranges are
 * `workspace:*` and its toolchain comes from the repo root, neither of which a
 * consumer has. So the names and scripts are the example's, the versions are this
 * release's, and the toolchain is `@dunx/create-app`'s own {@link DEV_TOOLCHAIN}.
 *
 * It exists at all because the starter used to ship seven files and no manifest,
 * leaving an agent to invent the one file where guessing wrong is silent:
 * `"type": "module"` absent turns every relative import into a resolution error.
 */
const starterManifest = (
  minimal: MinimalManifest,
  version: string,
  bun: string,
): string => {
  // Lockstep versioning, so the right version to install is the one that answered.
  // Same rule as `VERSION_PLACEHOLDER` in `@dunx/create-app`, resolved at
  // generation time here because the corpus is committed.
  const pin = (deps: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.keys(deps).map((name) => [
        name,
        name.startsWith('@dunx/') ? version : (deps[name] ?? 'latest'),
      ]),
    );

  return `${JSON.stringify(
    {
      // The name `dunx_start` tells an agent to scaffold with.
      name: 'my-api',
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: minimal.scripts,
      dependencies: pin(minimal.dependencies ?? {}),
      devDependencies: {
        ...pin(minimal.devDependencies ?? {}),
        ...DEV_TOOLCHAIN,
      },
      engines: { bun },
    },
    null,
    2,
  )}\n`;
};

interface MinimalManifest {
  readonly scripts: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

/**
 * `examples/minimal/src` plus a manifest, the base template's `bunfig.toml` and its
 * `tsconfig.json`: together the smallest app that installs, boots, tests and
 * typechecks. The example is booted and tested in CI; the base files are what a
 * generated app receives.
 */
const readStarter = async (): Promise<Starter> => {
  const files: StarterFile[] = [];

  const src = join(ROOT, 'examples/minimal/src');
  const names: string[] = [];
  for await (const file of new Bun.Glob('*.ts').scan({ cwd: src })) {
    names.push(file);
  }
  for (const name of names.sort()) {
    files.push({
      path: `src/${name}`,
      body: await Bun.file(join(src, name)).text(),
    });
  }

  const base = join(ROOT, 'tools/create-app/templates/base');
  files.push({
    path: 'bunfig.toml',
    body: await Bun.file(join(base, '_bunfig.toml')).text(),
  });
  files.push({
    path: 'tsconfig.json',
    body: await Bun.file(join(base, 'tsconfig.json')).text(),
  });

  const manifest = (await Bun.file(
    join(ROOT, 'examples/minimal/package.json'),
  ).json()) as MinimalManifest;
  const own = (await Bun.file(join(ROOT, 'tools/mcp/package.json')).json()) as {
    version: string;
    engines?: Record<string, string>;
  };
  const bun = own.engines?.['bun'] ?? '>=1.4.1';

  files.unshift({
    path: 'package.json',
    body: starterManifest(manifest, own.version, bun),
  });

  return {
    runtime: `bun ${bun}`,
    dependencies: Object.keys(manifest.dependencies ?? {}),
    // The toolchain is not in the example's manifest - the workspace root supplies
    // it there - and `tsc --noEmit` needs it here.
    devDependencies: [
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(DEV_TOOLCHAIN),
    ],
    files,
  };
};

/**
 * Annotated with `@dunx/mcp`'s `BootRule` rather than `@dunx/create-app`'s, so the
 * two shapes cannot drift without failing this file's typecheck.
 *
 * The assignment alone only catches drift one way: `@dunx/create-app` gaining a
 * field still assigns to a narrower `@dunx/mcp` shape. `Same` is the other
 * direction, so either package adding, removing or retyping a field is a compile
 * error here rather than a corpus that silently drops it.
 */
type Same<A, B> = A extends B ? (B extends A ? true : never) : never;
export const BOOT_RULE_SHAPES_AGREE: Same<BootRule, CreateAppBootRule> = true;

const readRules = (): readonly BootRule[] => BOOT_RULES;

const readScaffold = (): readonly ScaffoldFeature[] =>
  FEATURES.map((feature) => ({
    name: feature.name,
    summary: feature.summary,
    requires: feature.requires,
    dependencies: feature.dependencies,
    // Spread rather than assigned, so an absent service stays an absent key:
    // `exactOptionalPropertyTypes` rejects `service: undefined`.
    ...(feature.service === undefined ? {} : { service: feature.service }),
  }));

/**
 * `JSON.parse` of one string literal rather than an object literal spanning ten
 * thousand lines: it keeps the file at thirteen lines, which is what keeps `max-lines`
 * and `oxfmt` from having an opinion about generated data. Bun parses the whole
 * corpus in under a millisecond.
 */
const literal = (value: unknown): string =>
  JSON.stringify(JSON.stringify(value));

/**
 * Exported so `gen-mcp-corpus.test.ts` can re-render and compare, which is what
 * catches a committed corpus that a guide edit left behind. `gen:readme --check`
 * exists because nothing ran it and it silently broke; this is the same guard.
 */
export const renderCorpus = async (): Promise<string> => {
  const guide = await readGuide();
  const starter = await readStarter();
  const scaffold = readScaffold();

  return `// Generated by scripts/gen-mcp-corpus.ts - do not edit. Run \`bun run gen:mcp\`
// from the repo root. \`bun run build\` deliberately does not, or the drift test
// would compare a file the build had just rewritten.
import type { GuideDoc } from './guide.js';
import type { BootRule, ScaffoldFeature, Starter } from './scaffold.js';

/** Every chapter of \`docs/guide\`, with chapter links rewritten to \`dunx://guide/\`. */
export const GUIDE = JSON.parse(${literal(guide)}) as readonly GuideDoc[];

/** \`examples/minimal\` plus the base template, which is what an empty selection writes. */
export const MINIMAL = JSON.parse(${literal(starter)}) as Starter;

/** The features \`bunx @dunx/create-app\` composes an app from. */
export const SCAFFOLD = JSON.parse(${literal(scaffold)}) as readonly ScaffoldFeature[];

/** The rules a dunx app breaks by omission. Declared by \`@dunx/create-app\`. */
export const RULES = JSON.parse(${literal(readRules())}) as readonly BootRule[];
`;
};

export const CORPUS_PATH = OUT;

if (import.meta.main) {
  const rendered = await renderCorpus();
  await Bun.write(OUT, rendered);
  console.log(
    `tools/mcp/src/generated.ts  ${(rendered.length / 1024).toFixed(1)} KB`,
  );
}
