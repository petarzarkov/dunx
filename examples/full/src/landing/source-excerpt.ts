/** The class line and the constructor, cut out of a source file for the DI
 * panel. Separate from `VitalsController` so the shapes are testable. */

/** A top-level class declaration: where the excerpt starts and where the class
 * before it ended. The bound was a column-0 `}`, which is not anchored to brace
 * depth. */
const CLASS_DECLARATION = /^(?:export\s+)?(?:abstract\s+)?class\s/;

/** The close of a parameter list, whether or not the body is empty. */
const CONSTRUCTOR_END = /^\s*\)\s*(?:\{|$)/;
const CONSTRUCTOR_OPEN = /^\s*constructor\(/;

/**
 * Whatever sits between the class line and the constructor is dropped, so a doc
 * comment does not bury the parameter list; a class with no constructor yields
 * the declaration alone. The end pattern does not require `) {}`, which used to
 * truncate a bodied constructor to the class line with nothing reporting it.
 */
export const constructorExcerpt = (source: string): string => {
  const lines = source.split('\n');
  const opens = lines.findIndex((line) => CLASS_DECLARATION.test(line));
  if (opens === -1) return '';

  // Unbounded, a first class with no constructor borrowed the next class's.
  const ends = lines.findIndex(
    (line, index) => index > opens && CLASS_DECLARATION.test(line),
  );
  const limit = ends === -1 ? lines.length : ends;

  const ctor = lines.findIndex(
    (line, index) =>
      index > opens && index < limit && CONSTRUCTOR_OPEN.test(line),
  );
  if (ctor === -1) return lines[opens] ?? '';

  // A one-line constructor closes where it opened, so a search for a closing
  // line would run past it and find nothing.
  const closes = /\)\s*\{/.test(lines[ctor] ?? '')
    ? ctor
    : lines.findIndex(
        (line, index) => index > ctor && CONSTRUCTOR_END.test(line),
      );
  if (closes === -1) return lines[opens] ?? '';

  return [lines[opens], ...lines.slice(ctor, closes + 1)].join('\n');
};
