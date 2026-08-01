/**
 * What the bundler understands and TypeScript does not.
 *
 * `Bun.build` resolves a CSS side-effect import and inlines it into the emitted
 * stylesheet; to the type system it is just a module with no exports.
 */
declare module '*.css';

/**
 * The generated model is imported with `with { type: 'text' }`, so the module is
 * the file's *text*. TypeScript resolves a `.json` import to its parsed shape
 * regardless of the attribute, which is both the wrong type and a megabyte-wide
 * literal for the checker to carry — hence `resolveJsonModule: false` here and
 * this declaration in its place.
 */
declare module '*.json' {
  const text: string;
  export default text;
}
