/**
 * The entrypoint the process was started with, or undefined off Bun. Used only
 * to tell a prebuilt tree apart from a missing preload.
 */
const entrypoint = (): string | undefined =>
  typeof Bun === 'undefined' ? process.argv[1] : Bun.main;

const PRELOAD =
  '  # bunfig.toml\n' +
  '  preload = ["@dunx/transform/preload"]\n\n' +
  '  [test]\n' +
  '  preload = ["@dunx/transform/preload"]\n';

/**
 * Why a class has constructor parameters but no recorded dependencies.
 *
 * There are two causes and only one of them is the preload. The plugin registers
 * with `filter: /\.tsx?$/`, so it never sees an emitted `.js` no matter how it is
 * preloaded - telling someone running `bun dist/main.js` to add a preload they
 * already have sends them to check the one thing that is already correct. The
 * entrypoint's extension is what separates the two: a transpiled tree is being
 * run as JavaScript, so the fix is at build time instead.
 */
export const missingTransformMessage = (
  name: string,
  params: number,
  entry: string | undefined = entrypoint(),
): string => {
  const head =
    `${name} declares ${params} constructor parameter(s) but no dependencies ` +
    `were recorded for it, so @dunx/transform did not transform ${name}.`;

  if (entry !== undefined && /\.[cm]?js$/.test(entry)) {
    return (
      `${head} The entrypoint is ${entry}, so this is a prebuilt tree: the ` +
      'preload plugin only matches .ts, and no preload setting can change ' +
      'that. Record the dependencies at build time instead:\n\n' +
      "  import { depsPlugin } from '@dunx/transform';\n" +
      '  await Bun.build({ /* ... */ plugins: [depsPlugin] });\n'
    );
  }

  return `${head} Register the plugin, then retry:\n\n${PRELOAD}`;
};
