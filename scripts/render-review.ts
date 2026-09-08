/**
 * Turns a `/code-review` run into the body of a pull request review.
 *
 * `bun scripts/render-review.ts <execution-file> <body-out>` writes the markdown
 * and prints `approve` or `comment`.
 *
 * The reviewer emits its findings as the typed list the skill defines, and the
 * first review that reached a pull request was that list as raw JSON. Asking for
 * prose instead was tried and is the same bet that had already failed twice: an
 * appended instruction loses to the slash command's own. So the JSON is the
 * contract, rendering is this file's job, and a run that answers in prose anyway
 * still posts.
 */
interface Finding {
  readonly file?: string;
  readonly line?: number;
  readonly summary?: string;
  readonly short_summary?: string;
  readonly failure_scenario?: string;
  readonly verdict?: string;
  readonly category?: string;
}

const VERDICT = /^VERDICT: (APPROVE|COMMENT)$/m;

/**
 * The action writes either the result object or the whole event stream. A file
 * that is neither reads as no review, which the caller below reports as such: a
 * run killed before it flushed used to fail here with a raw `SyntaxError` instead.
 */
const resultOf = (raw: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '';
  }
  if (Array.isArray(parsed)) {
    const last = parsed.filter(
      (event): event is { type: string; result?: string } =>
        typeof event === 'object' && event !== null && 'type' in event,
    );
    return last.findLast((event) => event.type === 'result')?.result ?? '';
  }
  return (parsed as { result?: string }).result ?? '';
};

/**
 * Every candidate list in the message: each fenced block, plus the whole message
 * for a run that emitted a bare array.
 *
 * More than one, because the review that found this wrote two fenced blocks with a
 * `## Findings` heading between them. Reading only the first would have dropped a
 * finding, and reading only a whole-message fence would have dropped both.
 */
const FENCE = /^```(?:json)?[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm;

const blocksIn = (text: string): readonly string[] => {
  // Both fences anchored to a line, which is what markdown requires. Unanchored,
  // the lazy body stopped at the first ``` that happened to follow a newline
  // anywhere, including inside a block.
  const fenced = [...text.matchAll(FENCE)].map((match) => match[1] ?? '');
  return fenced.length > 0 ? fenced : [text];
};

/**
 * What the message says outside the list. A message that is nothing but a bare
 * array carries no prose, which is not the same as the array itself being prose.
 */
const proseOutside = (text: string): string => {
  const withoutFences = text.replace(FENCE, '').trim();
  return withoutFences === text.trim() && parseFindings(text) !== undefined
    ? ''
    : withoutFences;
};

const parseFindings = (block: string): readonly Finding[] | undefined => {
  const body = block.trim();
  if (!body.startsWith('[')) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed)) return undefined;
    // A list of anything else is not the findings contract, so it is left as prose.
    return parsed.every(
      (entry) =>
        typeof entry === 'object' && entry !== null && 'summary' in entry,
    )
      ? (parsed as Finding[])
      : undefined;
  } catch {
    return undefined;
  }
};

const findingsIn = (text: string): readonly Finding[] | undefined => {
  const lists = blocksIn(text)
    .map(parseFindings)
    .filter((list): list is readonly Finding[] => list !== undefined);
  return lists.length === 0 ? undefined : lists.flat();
};

const where = (finding: Finding): string => {
  if (finding.file === undefined) return '';
  const at = finding.line === undefined ? '' : `:${finding.line}`;
  return `\`${finding.file}${at}\``;
};

const render = (findings: readonly Finding[]): string => {
  if (findings.length === 0) {
    return 'Reviewed the diff and found nothing worth changing.';
  }

  const plural = findings.length === 1 ? 'finding' : 'findings';
  const lines = [`Reviewed the diff. ${findings.length} ${plural}.`, ''];

  for (const finding of findings) {
    const heading = [where(finding), finding.short_summary]
      .filter((part) => part !== undefined && part !== '')
      .join(' - ');
    lines.push(`### ${heading === '' ? 'Finding' : heading}`, '');
    if (finding.summary !== undefined) lines.push(finding.summary, '');
    if (finding.failure_scenario !== undefined) {
      lines.push(`**How it fails:** ${finding.failure_scenario}`, '');
    }
  }

  return lines.join('\n').trimEnd();
};

const [executionFile, bodyOut] = Bun.argv.slice(2);
if (executionFile === undefined || bodyOut === undefined) {
  console.error(
    'Usage: bun scripts/render-review.ts <execution-file> <body-out>',
  );
  process.exit(2);
}

const result = resultOf(await Bun.file(executionFile).text());
const findings = findingsIn(result);
const sentinel = VERDICT.exec(result)?.[1];

/**
 * An empty list means a clean review only when the message is nothing but that
 * list. `Array.prototype.every` is vacuously true on `[]`, so an illustrative
 * ```json []``` fence inside otherwise substantive prose parsed as a real empty
 * findings list and approved a pull request the reviewer had written up.
 */
const clean =
  findings !== undefined &&
  findings.length === 0 &&
  proseOutside(result) === '';

/**
 * The sentinel outranks the list whenever it is present, for the same reason: the
 * model saying COMMENT in words cannot be talked out of it by a stray fence. With
 * no sentinel, only a genuinely clean review approves.
 */
const verdict =
  sentinel === undefined
    ? clean
      ? 'approve'
      : 'comment'
    : sentinel === 'APPROVE'
      ? 'approve'
      : 'comment';

const body =
  findings !== undefined && findings.length > 0
    ? render(findings)
    : clean
      ? render([])
      : result.replace(VERDICT, '').trim();

if (body === '') {
  console.error('The reviewer produced no review. Not posting an empty one.');
  process.exit(1);
}

await Bun.write(bodyOut, `${body}\n`);
console.log(verdict);
