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

/** The action writes either the result object or the whole event stream. */
const resultOf = (raw: string): string => {
  const parsed: unknown = JSON.parse(raw);
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
const blocksIn = (text: string): readonly string[] => {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)].map(
    (match) => match[1] ?? '',
  );
  return fenced.length > 0 ? fenced : [text];
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

let body: string;
let verdict: string;

if (findings === undefined) {
  // Prose. The sentinel is the only signal available, and a missing one comments
  // rather than approves, so a forgotten line cannot approve by accident.
  verdict = VERDICT.exec(result)?.[1] === 'APPROVE' ? 'approve' : 'comment';
  body = result.replace(VERDICT, '').trim();
} else {
  verdict = findings.length === 0 ? 'approve' : 'comment';
  body = render(findings);
}

if (body === '') {
  console.error('The reviewer produced no review. Not posting an empty one.');
  process.exit(1);
}

await Bun.write(bodyOut, `${body}\n`);
console.log(verdict);
