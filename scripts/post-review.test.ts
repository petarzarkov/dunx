import { describe, expect, it } from 'bun:test';
import {
  buildReview,
  commentableLines,
  type Commentable,
} from './post-review.js';

const finding = (over: Record<string, unknown> = {}) => ({
  file: 'a.ts',
  line: 10,
  summary: 'It does the wrong thing.',
  failure_scenario: 'A caller passes x and gets y.',
  ...over,
});

const listed = (...findings: unknown[]) => JSON.stringify(findings);

const diff = (spec: Record<string, number[]>): Commentable =>
  new Map(Object.entries(spec).map(([file, lines]) => [file, new Set(lines)]));

/**
 * The whole review used to go in the body, which put a screen of prose in the
 * conversation on every push. The findings belong on the lines they are about.
 */
describe('building a review', () => {
  it('anchors each finding to its line and keeps the body a summary', () => {
    const review = buildReview(
      listed(finding(), finding({ file: 'b.ts', line: 3 })),
      diff({ 'a.ts': [10], 'b.ts': [3] }),
    );

    expect(review.event).toBe('COMMENT');
    expect(review.body).toBe('**Actionable comments posted: 2**');
    expect(review.comments).toEqual([
      {
        path: 'a.ts',
        line: 10,
        side: 'RIGHT',
        body: 'It does the wrong thing.\n\n**How it fails:** A caller passes x and gets y.',
      },
      {
        path: 'b.ts',
        line: 3,
        side: 'RIGHT',
        body: 'It does the wrong thing.\n\n**How it fails:** A caller passes x and gets y.',
      },
    ]);
  });

  /**
   * GitHub rejects the entire review if one comment names a line outside the
   * diff, so those are summarised rather than dropped or posted.
   */
  it('summarises a finding the diff cannot carry, collapsed', () => {
    const review = buildReview(
      listed(
        finding(),
        finding({ file: 'CLAUDE.md', line: 0, short_summary: 'Rule 4' }),
        finding({ file: 'untouched.ts', line: 900 }),
      ),
      diff({ 'a.ts': [10] }),
    );

    expect(review.comments).toHaveLength(1);
    expect(review.body).toContain('**Actionable comments posted: 1**');
    expect(review.body).toContain(
      '<details><summary>Outside the diff (2)</summary>',
    );
    expect(review.body).toContain('`CLAUDE.md:0` Rule 4');
    expect(review.body).toContain('`untouched.ts:900`');
  });

  it('approves an empty list and says so in one line', () => {
    const review = buildReview('[]', diff({}));
    expect(review.event).toBe('APPROVE');
    expect(review.comments).toEqual([]);
    expect(review.body).toBe(
      'Reviewed the diff and found nothing worth changing.',
    );
  });

  it('does not let a stray empty fence approve a flagged review', () => {
    const review = buildReview(
      'Found a problem.\n\n```json\n[]\n```\n\nVERDICT: COMMENT\n',
      diff({}),
    );
    expect(review.event).toBe('COMMENT');
    expect(review.body).toContain('Found a problem.');
  });

  it('takes prose as the body, with the verdict from the sentinel', () => {
    const review = buildReview('Looks fine.\n\nVERDICT: APPROVE\n', diff({}));
    expect(review.event).toBe('APPROVE');
    expect(review.body).toBe('Looks fine.');
    expect(review.comments).toEqual([]);
  });

  /**
   * `exec` returns the first match. A review that quotes the instruction before
   * ending on `VERDICT: COMMENT` would have been read from the quote.
   */
  it('reads the last sentinel, not the first', () => {
    const review = buildReview(
      'VERDICT: APPROVE\n\nOn reflection, it is not clean.\n\nVERDICT: COMMENT\n',
      diff({}),
    );
    expect(review.event).toBe('COMMENT');
    // Both whole-line sentinels are gone, wherever they sat.
    expect(review.body).toBe('On reflection, it is not clean.');
  });

  it('leaves a sentinel mentioned inside a sentence alone', () => {
    const review = buildReview(
      'The runner writes VERDICT: APPROVE when clean.\n\nVERDICT: COMMENT\n',
      diff({}),
    );
    expect(review.event).toBe('COMMENT');
    expect(review.body).toBe('The runner writes VERDICT: APPROVE when clean.');
  });

  it('comments when prose carries no sentinel', () => {
    expect(buildReview('Notes, no verdict.', diff({})).event).toBe('COMMENT');
  });

  it('collects findings from every fenced block', () => {
    const review = buildReview(
      `\`\`\`json\n${listed(finding())}\n\`\`\`\n\n## More\n\n` +
        `\`\`\`json\n${listed(finding({ file: 'b.ts', line: 3 }))}\n\`\`\``,
      diff({ 'a.ts': [10], 'b.ts': [3] }),
    );
    expect(review.comments).toHaveLength(2);
  });
});

describe('reading the diff', () => {
  it('counts right-hand lines and skips deletions', () => {
    const lines = commentableLines([
      {
        filename: 'a.ts',
        patch: [
          '@@ -1,3 +1,4 @@',
          ' keep',
          '-gone',
          '+added',
          '+more',
          ' tail',
        ].join('\n'),
      },
    ]);
    // 1 keep, 2 added, 3 more, 4 tail. The deletion consumes no right-hand line.
    expect([...(lines.get('a.ts') ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it('handles several hunks, and a file with no patch at all', () => {
    const lines = commentableLines([
      {
        filename: 'a.ts',
        patch: [
          '@@ -1,1 +1,1 @@',
          '+one',
          '@@ -50,1 +60,2 @@',
          '+sixty',
          '+sixtyone',
        ].join('\n'),
      },
      { filename: 'binary.png' },
    ]);
    expect([...(lines.get('a.ts') ?? [])]).toEqual([1, 60, 61]);
    expect(lines.has('binary.png')).toBe(false);
  });
});
