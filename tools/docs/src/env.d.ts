/**
 * What the bundler understands and TypeScript does not.
 *
 * Vite resolves a CSS side-effect import and inlines it into the emitted
 * stylesheet; to the type system it is just a module with no exports.
 */
declare module '*.css';

/**
 * The generated model is imported with Vite's `?raw` suffix, so the module is
 * the file's *text*. TypeScript would otherwise resolve a `.json` import to its
 * parsed shape, which is both the wrong type and a megabyte-wide literal for
 * the checker to carry — hence `resolveJsonModule: false` here and this
 * declaration in its place. Declared locally rather than pulled in from
 * `vite/client`, which would mean overriding the root tsconfig's `types`.
 */
declare module '*?raw' {
  const text: string;
  export default text;
}
