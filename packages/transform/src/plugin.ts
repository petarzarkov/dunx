import type { BunPlugin } from 'bun';
import { transform } from './deps.js';

/**
 * The source, read **through Bun's own loader** rather than with `Bun.file`.
 *
 * This is what keeps `bun --watch` and `bun --hot` working. A file that a runtime
 * `onLoad` reads behind Bun's back never enters the module graph, so it is never
 * watched: with `Bun.file` here, editing any imported file did nothing and only the
 * entrypoint still restarted. Measured both ways, and the transform was never the
 * cause - a plugin handing the source back byte for byte broke it identically.
 *
 * The three obvious repairs are all unavailable: `onLoad` may not decline (returning
 * `undefined` is a `TypeError`), `watchFiles` on the result is accepted and ignored,
 * and `filter` is a path regex so it cannot skip files whose contents decide.
 * Reading through `import` is the one that works, and it comes from
 * https://github.com/oven-sh/bun/issues/4689.
 *
 * The `?` matters: without it the specifier ends in `.ts` and re-enters this very
 * plugin. With it, the filter does not match and Bun loads the bytes itself.
 *
 * Everything in docs/bun-apis.md, "A runtime `onLoad` plugin drops the file it
 * loads from `--watch`".
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
       * A file with no `class` substring cannot contain a class declaration, so
       * the transform cannot change it - and parsing it is the whole cost. The
       * check is a native string scan against an `oxc-parser` pass, which is why
       * it is worth doing before deciding.
       *
       * Sound rather than heuristic: the transform only ever appends a statement
       * after a class *declaration*, and `class Foo`, `export class Foo`,
       * `export default class`, `abstract class` all contain it. Verified across
       * every tracked file in this repo - 200 class-free files, none of which the
       * transform altered. A false positive (`className` in a `.tsx`, the word in
       * a comment) just falls through to the parse, which is the current
       * behaviour.
       *
       * Measured on `examples/full` plus core and http: 117 loaded files, 29 of
       * them class-free, 8.3 ms of 33.8 ms of parse time saved. The check itself
       * costs 0.03 ms across all 117.
       */
      if (!source.includes('class')) return { contents: source, loader };

      return { contents: transform(source, path).code, loader };
    });
  },
};
