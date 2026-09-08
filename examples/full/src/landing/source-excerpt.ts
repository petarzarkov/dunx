/**
 * The class line and the constructor, cut out of a source file for the DI panel.
 * Separate from `VitalsController` so the shapes can be tested without a server.
 */

/** The close of a parameter list, whether or not the body is empty. */
const CONSTRUCTOR_END = /^\s*\)\s*(?:\{|$)/;
const CONSTRUCTOR_OPEN = /^\s*constructor\(/;

/**
 * Whatever sits between the class line and the constructor is dropped, so a doc
 * comment does not bury the parameter list. A class with no constructor yields
 * the declaration alone.
 *
 * The end pattern does not require `) {}`: it used to, so a constructor with a
 * body truncated the excerpt to the class line with nothing reporting it.
 */
export const constructorExcerpt = (source: string): string => {
  const lines = source.split('\n');
  const opens = lines.findIndex((line) => line.startsWith('export class '));
  if (opens === -1) return '';

  const ctor = lines.findIndex(
    (line, index) => index > opens && CONSTRUCTOR_OPEN.test(line),
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
