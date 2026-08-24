import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { dirname, resolve } from 'node:path';

/**
 * The site is a browser bundle, so its tests need a DOM before any module under
 * `src/` can load.
 *
 * It also needs Vite's `?raw` suffix, which the bundler understands and the
 * test runner does not: `src/data.ts` imports the generated model as text, and
 * without this plugin every test that touches it fails to resolve.
 */
GlobalRegistrator.register({ url: 'http://localhost/' });

Bun.plugin({
  name: 'vite-raw-imports',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(dirname(args.importer), args.path.replace(/\?raw$/, '')),
      namespace: 'vite-raw',
    }));

    build.onLoad({ filter: /.*/, namespace: 'vite-raw' }, async (args) => ({
      contents: `export default ${JSON.stringify(await Bun.file(args.path).text())};`,
      loader: 'js',
    }));
  },
});

/**
 * Unmount after every test, for every file.
 *
 * `render()` has no auto-cleanup under `bun test`: testing-library registers its
 * own only when it finds Jest's globals. Without it a `render` is never unmounted,
 * so `useRoute`'s `hashchange` listener survives the test that created it - and
 * `mount()` sets `window.location.hash` first thing, which then re-renders every
 * detached tree left by every earlier file. `symbol-anchor.test.tsx` ran 1.7s on
 * its own and 12.5s behind the other nine.
 *
 * Registered from the preload rather than per file so a new suite cannot forget it.
 */
const { cleanup } = await import('@testing-library/react');
const { afterEach } = await import('bun:test');
afterEach(cleanup);
