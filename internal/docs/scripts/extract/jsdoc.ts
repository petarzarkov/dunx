import type { Comment } from './ast';
import type { DocComment, DocTag } from './model';

/** `@example` bodies in this repo are full of decorators, and a line starting
 * `@Module(...)` inside a fence must not be read as a JSDoc tag. */
const TAG_START = /^@([a-zA-Z][\w-]*)[ \t]*(.*)$/;
const FENCE = /^(?:```|~~~)/;

const stripStars = (value: string): string[] =>
  value
    .replace(/^\*/, '')
    .split('\n')
    .map((line) => line.replace(/^[ \t]*\*[ \t]?/, ''));

export const parseJsdoc = (
  value: string,
  renderMarkdown: (md: string) => string,
): DocComment => {
  const lines = stripStars(value);
  const summary: string[] = [];
  const tags: { name: string; lines: string[] }[] = [];
  let fenced = false;

  for (const line of lines) {
    if (FENCE.test(line.trim())) fenced = !fenced;

    const match = fenced ? null : TAG_START.exec(line.trim());
    if (match) {
      tags.push({ name: match[1] ?? '', lines: [match[2] ?? ''] });
      continue;
    }

    const target = tags.at(-1);
    if (target) target.lines.push(line);
    else summary.push(line);
  }

  const dedent = (parts: string[]): string => parts.join('\n').trim();

  return {
    summary: renderMarkdown(dedent(summary)),
    tags: tags.map(
      (tag): DocTag => ({
        name: tag.name,
        text: renderMarkdown(dedent(tag.lines)),
      }),
    ),
  };
};

/**
 * Resolves the doc comment attached to a declaration: the nearest preceding
 * `/** *\/` block with nothing but whitespace between it and the declaration.
 * Binary search over the comment list keeps this linear across a whole file.
 */
export const createDocFinder = (
  source: string,
  comments: readonly Comment[],
): ((start: number) => Comment | undefined) => {
  const blocks = comments.filter(
    (comment) => comment.type === 'Block' && comment.value.startsWith('*'),
  );

  return (start) => {
    let low = 0;
    let high = blocks.length - 1;
    let found: Comment | undefined;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const candidate = blocks[mid];
      if (!candidate) break;
      if (candidate.end <= start) {
        found = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (!found) return undefined;
    return source.slice(found.end, start).trim() === '' ? found : undefined;
  };
};
