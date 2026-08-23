import type { BunPlugin } from 'bun';
import { transform } from './deps.js';

/**
 * The source, read through Bun's own loader rather than with `Bun.file`, which is
 * what keeps `bun --watch` working: a file a runtime `onLoad` reads behind Bun's
 * back never enters the module graph, so it is never watched.
 *
 * The three obvious repairs are unavailable - `onLoad` may not decline,
 * `watchFiles` is accepted and ignored, and `filter` is a path regex. Reading
 * through `import` is the one that works (oven-sh/bun#4689).
 *
 * The `?` matters: without it the specifier ends in `.ts` and re-enters this
 * plugin. See docs/bun-apis.md.
 */
const read = async (path: string): Promise<string> => {
  const module = (await import(`${path}?`, { with: { type: 'text' } })) as {
    default: string;
  };
  return module.default;
};

/**
 * Rewrites TypeScript as it is loaded so the container can read constructor
 * dependencies. Usable in three places, all the same object:
 *
 * - `bunfig.toml` -> `preload = ["@dunx/transform/preload"]` for `bun run`
 * - `Bun.build({ plugins: [depsPlugin] })` for a production build
 * - `Bun.plugin(depsPlugin)` from a test preload
 *
 * Dependencies are skipped: a published package was already transformed by its
 * own build, and re-parsing `node_modules` on every load is pure cost.
 */
export const depsPlugin: BunPlugin = {
  name: 'dunx-deps',
  setup(build) {
    // A runtime plugin's onLoad must always return a result - there is no
    // "decline and fall through", so untransformed files are handed back as-is.
    build.onLoad({ filter: /\.tsx?$/ }, async ({ path }) => {
      const source = await read(path);
      const loader = path.endsWith('.tsx') ? 'tsx' : 'ts';

      if (path.includes('/node_modules/')) return { contents: source, loader };

      /**
       * A file with no `class` substring cannot contain a class declaration, and
       * parsing it is the whole cost. Sound rather than heuristic: the transform
       * only appends after a class declaration, and every spelling of one
       * contains the word. A false positive falls through to the parse.
       *
       * Measured over 117 loaded files, 29 of them class-free: 8.3 ms of 33.8 ms
       * of parse time saved, for 0.03 ms of scanning.
       */
      if (!source.includes('class')) return { contents: source, loader };

      return { contents: transform(source, path).code, loader };
    });
  },
};
