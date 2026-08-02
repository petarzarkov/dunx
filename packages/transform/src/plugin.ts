import type { BunPlugin } from 'bun';
import { transform } from './deps.js';

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
      const source = await Bun.file(path).text();
      const loader = path.endsWith('.tsx') ? 'tsx' : 'ts';

      if (path.includes('/node_modules/')) return { contents: source, loader };

      return { contents: transform(source, path).code, loader };
    });
  },
};
