/**
 * Postgres dollar quoting: `$$body$$` or `$tag$body$tag$`. The tag has to match,
 * hence the backreference, and the body may contain anything including quotes.
 * Replaced first, or the quote rules below would read into it.
 */
const DOLLAR_QUOTED = /\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g;
/**
 * An `E'...'` escape string, where a backslash escapes the next character. Also
 * matched before the plain rule, which would stop at the first `'` a `\'` hid.
 */
const ESCAPE_STRING = /[eE]'(?:[^'\\]|\\[\s\S]|'')*'/g;
/** A single-quoted literal, `''` escapes included. */
const STRING_LITERAL = /'(?:[^']|'')*'/g;
/** A bare number that is not part of an identifier or a `$1` placeholder. */
const NUMBER_LITERAL = /(?<![\w$.])\d+(?:\.\d+)?/g;

/**
 * The statement's shape, with its literals replaced. drizzle parameterises, so a
 * query it built carries no values - but `sql` template escape hatches and
 * hand-written statements do, and a `where email = 'ada@example.com'` in a
 * metrics payload or an exported span is the leak.
 */
export const sanitize = (sql: string): string =>
  sql
    .replace(DOLLAR_QUOTED, '$$?$$')
    .replace(ESCAPE_STRING, "E'?'")
    .replace(STRING_LITERAL, "'?'")
    .replace(NUMBER_LITERAL, '?');

const FIRST_WORD = /^\s*([A-Za-z]+)/;
const IDENTIFIER = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\w+)`;
const QUALIFIED = `(${IDENTIFIER}(?:\\.${IDENTIFIER})?)`;
/** The three writes name their one table up front. */
const WRITE_TARGET = new RegExp(
  String.raw`^\s*(?:insert\s+into|update|delete\s+from)\s+${QUALIFIED}`,
  'i',
);
const FROM_TARGET = new RegExp(String.raw`\bfrom\s+${QUALIFIED}`, 'i');
const FROM = /\bfrom\b/gi;
const JOIN = /\bjoin\b/i;
const QUOTES = /["\x60]/g;

export interface StatementSummary {
  /** The leading keyword, upper-cased; absent for a CTE, which can end in anything. */
  readonly operation?: string;
  /** The one table the statement reads or writes, when that is unambiguous. */
  readonly target?: string;
}

/**
 * A select names a target only with one `from` and no join: a subquery or a
 * second table makes the first `from` a guess, and a wrong table on a span is
 * worse than none. Read off the sanitized text, so a literal cannot hold a `from`.
 */
const targetOf = (operation: string, shape: string): string | undefined => {
  let match: RegExpExecArray | null = null;
  if (operation === 'SELECT') {
    if ((shape.match(FROM)?.length ?? 0) !== 1 || JOIN.test(shape)) {
      return undefined;
    }
    match = FROM_TARGET.exec(shape);
  } else {
    match = WRITE_TARGET.exec(shape);
  }
  return match?.[1]?.replace(QUOTES, '');
};

export const summarise = (shape: string): StatementSummary => {
  const operation = FIRST_WORD.exec(shape)?.[1]?.toUpperCase();
  if (operation === undefined || operation === 'WITH') return {};
  const target = targetOf(operation, shape);
  return target === undefined ? { operation } : { operation, target };
};
