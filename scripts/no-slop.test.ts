import { describe, expect, it } from 'bun:test';
import { $ } from 'bun';
import { existsSync } from 'node:fs';

/**
 * Enforces the documentation voice rules in CLAUDE.md, the way
 * `no-em-dash.test.ts` enforces the dash rule: as a test over every tracked
 * Markdown file rather than as advice a reviewer has to remember.
 *
 * oxlint cannot do this for the same reason it cannot do the dashes. These are
 * prose defects in Markdown, and a linter that only reads TypeScript would see
 * none of them.
 *
 * The patterns here were measured against this repository before they were
 * chosen. The generic AI-slop vocabulary that circulates online (`seamless`,
 * `robust`, `leverage`, `delve`) scored **one** hit across 9,877 lines of
 * `docs/`, so banning it alone would have been a no-op that read as a fix. What
 * this corpus actually overuses is three sentence shapes, listed below, which
 * together ran to 628 occurrences. They are budgeted rather than banned: each is
 * legitimate occasionally, and the defect is the density.
 */

const Mode = Object.freeze({
  Tutorial: 'tutorial',
  Reference: 'reference',
  Explanation: 'explanation',
  Exempt: 'exempt',
} as const);
type Mode = (typeof Mode)[keyof typeof Mode];

interface Budget {
  /** Structural slop hits allowed per 100 lines of prose. */
  readonly slopPer100: number;
  /** Longest single paragraph, in characters. */
  readonly paragraphChars: number;
}

/**
 * Explanation is looser on both axes on purpose. `docs/architecture/*` exists to
 * argue a decision against the alternative it beat, so "X, not Y" is the genuine
 * shape of its content rather than a tic. A guide describing what a method does
 * has no such excuse.
 */
const BUDGETS: Readonly<Record<Mode, Budget>> = Object.freeze({
  [Mode.Tutorial]: { slopPer100: 2, paragraphChars: 420 },
  [Mode.Reference]: { slopPer100: 2, paragraphChars: 420 },
  [Mode.Explanation]: { slopPer100: 4, paragraphChars: 600 },
  [Mode.Exempt]: { slopPer100: Infinity, paragraphChars: Infinity },
});

/**
 * First match wins, so order matters. Anything unmatched is Exempt: a new
 * `.md` somewhere unexpected should not fail CI until someone decides what it
 * is.
 */
const MODES: readonly (readonly [RegExp, Mode])[] = [
  // Has to quote the patterns it bans, exactly as CLAUDE.md has to name the
  // dash characters for `no-em-dash.test.ts`.
  [/^scripts\/no-slop\.test\.ts$/, Mode.Exempt],
  [/^\.claude\/skills\/docs-pass\/SKILL\.md$/, Mode.Exempt],
  // Instructions to an agent and templates for a human, not documentation
  // anyone reads to learn dunx.
  [/^CLAUDE\.md$/, Mode.Exempt],
  [/^\.claude\//, Mode.Exempt],
  [/^\.github\//, Mode.Exempt],
  // Planning records, written to be superseded. The working notes moved to `internal/notes/`, which the `internal/` rule
  // below already exempts. This is the public summary the README links.
  [/^docs\/ROADMAP\.md$/, Mode.Exempt],
  // Private workspaces. `internal/bench/README.md` is a long argument about
  // methodology and is meant to be.
  [/^internal\//, Mode.Exempt],
  // Fetched by an agent rather than read on the site, and served raw at
  // /dunx/setup.md. Instructions to a machine still have a reader.
  [/^docs\/setup\.md$/, Mode.Reference],
  [/^docs\/guide\/01-introduction\.md$/, Mode.Explanation],
  [/^docs\/guide\/02-first-steps\.md$/, Mode.Tutorial],
  [/^docs\/guide\//, Mode.Reference],
  [/^docs\/architecture\//, Mode.Explanation],
  [/^docs\/ARCHITECTURE\.md$/, Mode.Explanation],
  [/^docs\/bun-apis\.md$/, Mode.Explanation],
  [/^docs\/MIGRATION-FROM-NEST\.md$/, Mode.Reference],
  [/^(packages|tools|examples)\/[^/]+\/README\.md$/, Mode.Reference],
  [/^README\.md$/, Mode.Reference],
  [/^CONTRIBUTING\.md$/, Mode.Reference],
  // Commit subjects, assembled by `scripts/version.ts`. A prose budget over
  // text this file did not write would fail on what someone typed months ago.
  // The dash rule still applies, and the generator applies it.
  [/^CHANGELOG\.md$/, Mode.Exempt],
];

const modeOf = (file: string): Mode =>
  MODES.find(([pattern]) => pattern.test(file))?.[1] ?? Mode.Exempt;

/**
 * Marketing vocabulary and the stock LLM connectives. Zero tolerance, because
 * unlike the structural patterns none of these has a legitimate use in a
 * technical document: every one of them is a claim with no measurement behind
 * it, or a sentence that exists to introduce the next sentence.
 */
const BANNED_WORDS =
  /\b(?:seamless(?:ly)?|robust|leverages?|leveraging|delve|delving|testament|crucial(?:ly)?|effortless(?:ly)?|game.changers?|unleash(?:es|ing)?|demystif(?:y|ies|ying)|blazing(?:ly)? fast|battle.tested|first.class citizen|supercharge[sd]?|turnkey|plethora|myriad|treasure trove|rich set of|wide (?:range|array) of|out of the box)\b/gi;

/**
 * Sentences whose only job is to announce or applaud another sentence.
 */
const BANNED_FRAMES =
  /(?:in this (?:guide|section|chapter|article|post|tutorial|document)|let(?:'|’)?s (?:take a look|look at|dive|explore|start|begin|get started|walk through|see)|here(?:'|’)?s how you can|here is how you can|it(?:'|’)?s important to note|it is important to note|now that (?:we|you)(?:'|’)?(?:ve| have)|we(?:'|’)?ll (?:explore|cover|look at|see|learn)|we will (?:explore|cover|look at|see|learn)|by the end of this|in conclusion|congratulations|happy coding|and that(?:'|’)?s it|that(?:'|’)?s all there is)/gi;

/**
 * Antithesis. Defines a thing by what it is not, then supplies the correction:
 * "Colour encodes the runtime, not the ranking." One is a clarification, six in
 * a page is a mannerism.
 */
const ANTITHESIS = /,\s+not\s+\w+/gi;

/**
 * The knowing closer. A sentence that steps back to tell the reader what they
 * just read meant.
 */
const CLOSER =
  /\b(?:which is (?:why|what|the)|that is (?:the point|what|why|exactly)|the whole point|and that is|is exactly (?:what|why|the)|is precisely)\b/gi;

/**
 * Self-congratulation on the design. Documentation states behaviour; the
 * reasoning belongs in `docs/architecture/`, which is why Explanation gets a
 * wider budget for it.
 */
const KNOWING =
  /\b(?:deliberately|on purpose|worth knowing|worth recording|it is worth|the reason (?:is|for)|by design)\b/gi;

const STRUCTURAL: readonly (readonly [string, RegExp])[] = [
  ['antithesis', ANTITHESIS],
  ['closer', CLOSER],
  ['knowing', KNOWING],
];

interface Prose {
  /** Lines outside fenced code. */
  readonly lines: readonly string[];
  /** Paragraphs: runs of consecutive prose lines, tables and lists excluded. */
  readonly paragraphs: readonly string[];
}

const isStructure = (line: string): boolean =>
  line.startsWith('#') ||
  line.startsWith('|') ||
  line.startsWith('>') ||
  line.startsWith('<') ||
  // A badge row is markup, not prose. `README.md` opens with eight of them on
  // consecutive lines, which measured as one 533-character paragraph.
  line.startsWith('[![') ||
  line.startsWith('![') ||
  /^\s*(?:[-*+]|\d+\.)\s/.test(line) ||
  /^\s{2,}\S/.test(line);

/**
 * Splits a document into the prose a reader has to wade through. Fenced code is
 * dropped whole, and so are tables and list items: a long table is dense
 * reference material, and capping it would push writing back toward paragraphs.
 */
const readProse = (text: string): Prose => {
  const lines: string[] = [];
  const paragraphs: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = (): void => {
    if (current.length > 0) paragraphs.push(current.join(' '));
    current = [];
  };

  for (const raw of text.split('\n')) {
    if (raw.trimStart().startsWith('```')) {
      inFence = !inFence;
      flush();
      continue;
    }
    if (inFence) continue;

    lines.push(raw);
    // `isStructure` reads the **raw** line: its continuation-line rule is an
    // indentation test, and trimming first made every wrapped list item read as
    // a fresh paragraph.
    if (raw.trim() === '' || isStructure(raw)) flush();
    else current.push(raw.trim());
  }
  flush();

  return { lines, paragraphs };
};

const count = (text: string, pattern: RegExp): number =>
  (text.match(pattern) ?? []).length;

interface Offence {
  readonly file: string;
  readonly detail: string;
}

describe('documentation voice', () => {
  const files = async (): Promise<string[]> => {
    const listed =
      await $`git ls-files --cached --others --exclude-standard`.text();
    return listed
      .split('\n')
      .filter((f) => f.endsWith('.md'))
      .filter((f) => modeOf(f) !== Mode.Exempt);
  };

  it('uses no marketing vocabulary or announcement sentences', async () => {
    const offences: Offence[] = [];

    for (const file of await files()) {
      const text = await Bun.file(file)
        .text()
        .catch(() => '');
      const prose = readProse(text).lines.join('\n');

      for (const [label, pattern] of [
        ['banned word', BANNED_WORDS],
        ['announcement', BANNED_FRAMES],
      ] as const) {
        for (const hit of new Set(prose.match(pattern) ?? [])) {
          offences.push({ file, detail: `${label}: "${hit}"` });
        }
      }
    }

    expect(offences).toEqual([]);
  });

  it('keeps the three overused sentence shapes under budget', async () => {
    const offences: Offence[] = [];

    for (const file of await files()) {
      const text = await Bun.file(file)
        .text()
        .catch(() => '');
      const { lines } = readProse(text);
      const prose = lines.join('\n');
      const budget = BUDGETS[modeOf(file)].slopPer100;

      const hits = STRUCTURAL.reduce(
        (sum, [, pattern]) => sum + count(prose, pattern),
        0,
      );
      const per100 = (hits / Math.max(lines.length, 1)) * 100;

      if (per100 > budget) {
        const breakdown = STRUCTURAL.map(
          ([label, pattern]) => `${label} ${count(prose, pattern)}`,
        ).join(', ');
        offences.push({
          file,
          detail: `${per100.toFixed(1)} per 100 prose lines, budget ${budget} (${breakdown})`,
        });
      }
    }

    expect(offences).toEqual([]);
  });

  it('breaks up walls of prose', async () => {
    const offences: Offence[] = [];

    for (const file of await files()) {
      const text = await Bun.file(file)
        .text()
        .catch(() => '');
      const budget = BUDGETS[modeOf(file)].paragraphChars;

      for (const paragraph of readProse(text).paragraphs) {
        if (paragraph.length > budget) {
          offences.push({
            file,
            detail: `${paragraph.length} char paragraph, budget ${budget}: "${paragraph.slice(0, 60)}..."`,
          });
        }
      }
    }

    expect(offences).toEqual([]);
  });
});

/**
 * The same voice, in the surface the prose rules never covered. `packages/` and
 * `tools/` measured 31.5% comment lines when this was written, and the densest
 * were design memos in JSDoc costume: the argument for a decision, the
 * alternative it beat, and the measurement behind it, in a file a reader opened
 * to find out what a class does.
 *
 * Length, not count, is what separates those from a comment that earns its place.
 * The median block here is four lines; the mass sat in the tail, where 131 blocks
 * over twelve lines held 2,437 lines - 30% of every comment in 8% of the blocks.
 * A flat density budget charges a public API for having many short doc comments,
 * and `internal/docs` builds its API reference out of exactly those.
 *
 * So `blockLines` is the rule with teeth and `density` is a backstop against
 * regression, set just above what a full pass achieved. A comment earns its place
 * by explaining why the obvious implementation is wrong; the argument goes in
 * `docs/architecture/`, where the prose budgets above already apply to it.
 */
interface SourceBudget {
  /** Longest single run of comment lines. */
  readonly blockLines: number;
  /** Share of a group's lines that may be comment. */
  readonly density: number;
}

const SOURCE_BUDGETS: readonly (readonly [RegExp, SourceBudget])[] = [
  // An example is read top to bottom, so prose there costs a reader who came for
  // the code.
  [/^examples\//, { blockLines: 10, density: 17 }],
  [/^(?:packages|tools)\//, { blockLines: 12, density: 29 }],
];

interface Counted {
  readonly lines: number;
  readonly comment: number;
  /**
   * Every run of consecutive whole-line comments, as `[line, prose]`. A fenced
   * example inside a doc comment is the most useful thing in it, so it counts as
   * comment for the file's density but not toward the block's prose length.
   */
  readonly blocks: readonly (readonly [number, number])[];
}

/**
 * Whole-line comments only. A trailing `// why` costs a reader nothing, and
 * counting it would push writing toward the block form this is trying to thin.
 */
const countComments = (text: string): Counted => {
  const lines = text.split('\n');
  const blocks: [number, number][] = [];
  let comment = 0;
  let inBlock = false;
  let fenced = false;
  let run = 0;
  let prose = 0;

  lines.forEach((raw, index) => {
    const line = raw.trim();
    let isComment = inBlock;

    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
    } else if (line.startsWith('/*')) {
      isComment = true;
      if (!line.includes('*/')) inBlock = true;
    } else if (line.startsWith('//')) {
      isComment = true;
    }

    if (isComment) {
      comment++;
      run++;
      const body = line.replace(/^[/*]+ ?/, '').trim();
      if (body.startsWith('```')) fenced = !fenced;
      // A separator is not prose, and a fenced example is the most useful thing
      // in a doc comment - neither is what the cap is measuring.
      else if (!fenced && body !== '') prose++;
      return;
    }
    if (run > 0) blocks.push([index + 1 - run, prose]);
    run = 0;
    prose = 0;
    fenced = false;
  });

  if (run > 0) blocks.push([lines.length + 1 - run, prose]);
  return { lines: lines.length, comment, blocks };
};

const budgetFor = (file: string): SourceBudget | undefined =>
  SOURCE_BUDGETS.find(([pattern]) => pattern.test(file))?.[1];

describe('source comments', () => {
  const sources = async (): Promise<string[]> => {
    const listed =
      await $`git ls-files --cached --others --exclude-standard`.text();
    return (
      listed
        .split('\n')
        .filter((f) => /\.tsx?$/.test(f))
        // A test's comments explain a fixture to whoever debugs it, and counting
        // them would let a dense source file hide behind a comment-free suite.
        .filter((f) => !/\.test\.tsx?$/.test(f))
        // A template is a working app vendored into the scaffolder, measured where
        // it lives in `examples/full`.
        .filter((f) => !f.includes('/templates/'))
        // `--cached` lists the index, which still holds a file deleted from the
        // working tree but not yet staged - and reading it threw ENOENT rather
        // than reporting a voice offence.
        .filter((f) => existsSync(f))
        .filter((f) => budgetFor(f) !== undefined)
    );
  };

  it('has no comment block long enough to be a design memo', async () => {
    const offences: Offence[] = [];

    for (const file of await sources()) {
      const budget = budgetFor(file) as SourceBudget;
      const { blocks } = countComments(await Bun.file(file).text());

      for (const [line, prose] of blocks) {
        if (prose > budget.blockLines) {
          offences.push({
            file: `${file}:${line}`,
            detail: `${prose} lines of comment prose, cap ${budget.blockLines}. State the behaviour here and move the argument to docs/architecture/.`,
          });
        }
      }
    }

    expect(offences).toEqual([]);
  });

  it('keeps each group under its share of comment lines', async () => {
    const totals = new Map<number, { lines: number; comment: number }>();

    for (const file of await sources()) {
      const { density } = budgetFor(file) as SourceBudget;
      const counted = countComments(await Bun.file(file).text());
      const running = totals.get(density) ?? { lines: 0, comment: 0 };
      totals.set(density, {
        lines: running.lines + counted.lines,
        comment: running.comment + counted.comment,
      });
    }

    const offences: Offence[] = [];
    for (const [density, { lines, comment }] of totals) {
      const pct = (comment / Math.max(lines, 1)) * 100;
      if (pct > density) {
        offences.push({
          file: `group budget ${density}%`,
          detail: `${pct.toFixed(1)}% (${comment}/${lines} lines)`,
        });
      }
    }

    expect(offences).toEqual([]);
  });
});
