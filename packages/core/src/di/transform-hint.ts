/**
 * The entrypoint the process was started with, or undefined off Bun. Used only
 * to tell a prebuilt tree apart from a missing preload.
 */
const entrypoint = (): string | undefined =>
  typeof Bun === 'undefined' ? process.argv[1] : Bun.main;

/**
 * Written by `@dunx/transform`'s plugin when it registers. `Symbol.for` and a
 * string literal rather than an import: core does not depend on the transform,
 * and the key has to survive a second copy of either package.
 */
const ACTIVE = Symbol.for('dunx.transform.active');

const pluginRegistered = (): boolean =>
  (globalThis as unknown as Record<symbol, unknown>)[ACTIVE] === true;

const PRELOAD =
  '  # bunfig.toml\n' +
  '  preload = ["@dunx/transform/preload"]\n\n' +
  '  [test]\n' +
  '  preload = ["@dunx/transform/preload"]\n';

const BUILD =
  "  import { depsPlugin } from '@dunx/transform';\n" +
  '  await Bun.build({ /* ... */ plugins: [depsPlugin] });\n';

/**
 * Why a class has constructor parameters but no recorded dependencies.
 *
 * There are three causes and only one of them is the preload, so guessing sends
 * people to check something already correct. Two signals separate them. The
 * entrypoint's extension: the plugin registers with `filter: /\.tsx?$/`, so it
 * never sees an emitted `.js` no matter how it is preloaded, and a transpiled
 * tree has to be fixed at build time. Then whether the plugin registered at all:
 * if it did and this class still has no record, the file was outside its reach,
 * and `node_modules` is the way that happens - a published package records its
 * own dependencies or nobody can inject its classes.
 */
export const missingTransformMessage = (
  name: string,
  params: number,
  entry: string | undefined = entrypoint(),
  registered: boolean = pluginRegistered(),
): string => {
  const head =
    `${name} declares ${params} constructor parameter(s) but no dependencies ` +
    `were recorded for it, so @dunx/transform did not transform ${name}.`;

  if (entry !== undefined && /\.[cm]?js$/.test(entry)) {
    return (
      `${head} The entrypoint is ${entry}, so this is a prebuilt tree: the ` +
      'preload plugin only matches .ts, and no preload setting can change ' +
      'that. Record the dependencies at build time instead:\n\n' +
      BUILD
    );
  }

  if (registered) {
    return (
      `${head} The plugin is registered, so the preload is not the problem. ` +
      `Two things it does not reach. If ${name} is a class expression, declare ` +
      'it instead: the name in `const X = class X {}` is bound inside the class ' +
      `body, so nothing can be appended after it. If ${name} comes from an ` +
      'installed package, node_modules is skipped and that package records its ' +
      'dependencies in its own build, which is a fix for whoever publishes ' +
      'it:\n\n' +
      BUILD
    );
  }

  return `${head} Register the plugin, then retry:\n\n${PRELOAD}`;
};
