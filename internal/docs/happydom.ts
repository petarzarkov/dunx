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
