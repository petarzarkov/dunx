export interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Splices edits into the original text rather than reprinting the AST, so
 * everything untouched keeps its exact bytes — comments, formatting, and the
 * line numbers stack traces point at.
 */
export const applyEdits = (source: string, edits: readonly Edit[]): string => {
  const sorted = [...edits].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );

  let out = '';
  let cursor = 0;

  for (const edit of sorted) {
    if (edit.start < cursor) {
      throw new Error(
        `Overlapping edit at ${edit.start}..${edit.end}; the previous edit ended ` +
          `at ${cursor}.`,
      );
    }
    out += source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }

  return out + source.slice(cursor);
};
