import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Glob } from 'bun';
import {
  CONFIG_GROUPS,
  FEATURES,
  featureNames,
  impliedBy,
  resolveFeatures,
  UnknownFeatureError,
} from './features.js';
import { THIRD_PARTY } from './generate.js';

const ROOT = new URL('../../..', import.meta.url).pathname;
const EXAMPLE = join(ROOT, 'examples/full/src');
const VENDORED = join(ROOT, 'tools/create-app/templates/features');

/**
 * The whole reason the features are sourced from `examples/full`: that example is
 * built, typechecked, tested and toured in CI on every push, so what gets
 * scaffolded is code the repo actually runs. A copy drifts silently, so this fails
 * the moment one does and names the file to sync.
 *
 * `bun run sync:templates` is what fixes a failure here.
 */
describe('the vendored features', () => {
  test.each(FEATURES.map((feature) => [feature.name, feature.source]))(
    '%s matches examples/full/src/%s byte for byte',
    async (_name, source) => {
      const from = join(EXAMPLE, source);
      const to = join(VENDORED, source);

      const names: string[] = [];
      for await (const file of new Glob('**/*').scan({
        cwd: from,
        onlyFiles: true,
      })) {
        names.push(file);
      }
      expect(names.length).toBeGreaterThan(0);

      for (const file of names) {
        expect(await Bun.file(join(to, file)).text()).toBe(
          await Bun.file(join(from, file)).text(),
        );
      }
    },
  );

  test('vendors no directory that no feature names', async () => {
    const dirs = new Set<string>();
    for await (const file of new Glob('*/**').scan({
      cwd: VENDORED,
      onlyFiles: true,
    })) {
      dirs.add(file.split('/')[0] ?? '');
    }
    expect([...dirs].sort()).toEqual(
      FEATURES.map((feature) => feature.source).sort(),
    );
  });

  /**
   * The gap `check:scaffolds` cannot see. It typechecks a scaffold *inside*
   * `examples/full`, whose `node_modules` already holds every package, so a feature
   * whose declared dependencies are missing one still passes there - and then a real
   * consumer's `bun install` produces an app that imports something absent from its
   * own manifest. Six features were wrong when this was written.
   */
  test.each(FEATURES.map((feature) => [feature.name, feature] as const))(
    '%s declares every package its directory imports',
    async (_name, feature) => {
      const always = new Set([
        '@dunx/core',
        '@dunx/http',
        '@dunx/transform',
        '@dunx/infra',
        ...feature.dependencies,
      ]);

      const imported = new Set<string>();
      for await (const file of new Glob('**/*.ts').scan({
        cwd: join(EXAMPLE, feature.source),
      })) {
        const source = await Bun.file(
          join(EXAMPLE, feature.source, file),
        ).text();
        for (const match of source.matchAll(/from ['"]([^.'"][^'"]*)['"]/g)) {
          const specifier = match[1] ?? '';
          if (specifier.startsWith('node:') || specifier === 'bun') continue;
          imported.add(
            specifier.startsWith('@')
              ? specifier.split('/').slice(0, 2).join('/')
              : (specifier.split('/')[0] ?? specifier),
          );
        }
      }

      expect([...imported].filter((pkg) => !always.has(pkg))).toEqual([]);
    },
  );

  /**
   * The generated manifest pins its own third-party ranges rather than reading the
   * example's, because the example installs from the workspace. They still have to
   * agree, or a consumer gets a combination nothing exercises.
   */
  test('pins the third-party versions the full example is tested against', async () => {
    const manifest = (await Bun.file(
      join(ROOT, 'examples/full/package.json'),
    ).json()) as { dependencies: Record<string, string> };

    for (const [pkg, range] of Object.entries(THIRD_PARTY)) {
      expect(manifest.dependencies[pkg]).toBe(range);
    }
  });
});

describe('the registry', () => {
  test('names a real directory, module and config group for every feature', () => {
    for (const feature of FEATURES) {
      expect(feature.summary.length).toBeGreaterThan(20);
      expect(feature.module.from).toContain(`/${feature.source}/`);
      for (const group of feature.config) {
        expect(CONFIG_GROUPS[group]).toBeDefined();
      }
      for (const required of feature.requires) {
        expect(featureNames).toContain(required);
      }
    }
  });

  test('has no duplicate names, sources or module classes', () => {
    const unique = (values: readonly string[]) => new Set(values).size;
    expect(unique(FEATURES.map((f) => f.name))).toBe(FEATURES.length);
    expect(unique(FEATURES.map((f) => f.source))).toBe(FEATURES.length);
    expect(unique(FEATURES.map((f) => f.module.klass))).toBe(FEATURES.length);
  });
});

describe('resolveFeatures', () => {
  test('pulls in what a feature requires', () => {
    const resolved = resolveFeatures(['users']).map((f) => f.name);
    expect(resolved).toEqual(['database', 'users']);
    expect(impliedBy(['users'], resolveFeatures(['users']))).toEqual([
      'database',
    ]);
  });

  /** Import order is construction order, so a requirement is built first. */
  test('emits a feature after everything it requires', () => {
    for (const feature of FEATURES) {
      const resolved = resolveFeatures([feature.name]).map((f) => f.name);
      for (const required of feature.requires) {
        expect(resolved.indexOf(required)).toBeLessThan(
          resolved.indexOf(feature.name),
        );
      }
    }
  });

  test('resolves transitively', () => {
    // health requires cache, database and files; jobs requires images. `files` joined
    // health's list when module scoping made the dependency explicit - its controller
    // injects `Storage`, so the module has to import the one that provides it.
    expect(resolveFeatures(['health']).map((f) => f.name)).toEqual([
      'database',
      'cache',
      'files',
      'health',
    ]);
    expect(resolveFeatures(['jobs']).map((f) => f.name)).toEqual([
      'images',
      'jobs',
    ]);
  });

  /** Two runs asking for the same set must generate byte-identical files. */
  test('is order-independent and deduplicated', () => {
    const one = resolveFeatures(['users', 'database', 'notes']);
    const two = resolveFeatures(['notes', 'users', 'database']);
    expect(one.map((f) => f.name)).toEqual(two.map((f) => f.name));
    expect(new Set(one.map((f) => f.name)).size).toBe(one.length);
  });

  test('resolves every feature at once without duplicating one', () => {
    const all = resolveFeatures(featureNames);
    expect(all).toHaveLength(FEATURES.length);
  });

  test('names the available features when given an unknown one', () => {
    expect(() => resolveFeatures(['redis'])).toThrow(UnknownFeatureError);
    try {
      resolveFeatures(['redis', 'postgres']);
    } catch (error) {
      expect(String(error)).toContain('redis, postgres');
      expect(String(error)).toContain('cache');
    }
  });

  test('resolves nothing for an empty selection', () => {
    expect(resolveFeatures([])).toEqual([]);
  });
});
