/**
 * Posts a `/code-review` run as one pull request review: a short summary, and each
 * finding as an inline comment on the line it is about.
 *
 * `bun scripts/post-review.ts <execution-file> <owner/repo> <number> <sha>`
 *
 * The whole review used to go in the body, which put a screen of prose in the
 * conversation for every push. GitHub takes the comments with the review in one
 * `POST`, so this is still one review per run rather than a comment per finding.
 */
interface Finding {
  readonly file?: string;
  readonly line?: number;
  readonly summary?: string;
  readonly short_summary?: string;
  readonly failure_scenario?: string;
}

export interface ReviewComment {
  readonly path: string;
  readonly line: number;
  readonly side: 'RIGHT';
  readonly body: string;
}

export interface Review {
  readonly event: 'APPROVE' | 'COMMENT';
  readonly body: string;
  readonly comments: readonly ReviewComment[];
}

/** Line numbers on the right-hand side of the diff, which are the commentable ones. */
export type Commentable = ReadonlyMap<string, ReadonlySet<number>>;

const VERDICT = /^VERDICT: (APPROVE|COMMENT)$/gm;

/**
 * The last sentinel, not the first. The instruction says to end the message with
 * one, and a review that quotes the instruction before ending on
 * `VERDICT: COMMENT` would otherwise be read from the quote and approved.
 */
const verdictIn = (text: string): string | undefined =>
  [...text.matchAll(VERDICT)].at(-1)?.[1];

/** Only the sentinel lines, wherever they are, so none is left in the body. */
const withoutVerdict = (text: string): string =>
  text.replace(VERDICT, '').trim();
const FENCE = /^```(?:json)?[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm;

const resultOf = (raw: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '';
  }
  if (Array.isArray(parsed)) {
    return (
      parsed
        .filter(
          (event): event is { type: string; result?: string } =>
            typeof event === 'object' && event !== null && 'type' in event,
        )
        .findLast((event) => event.type === 'result')?.result ?? ''
    );
  }
  return (parsed as { result?: string }).result ?? '';
};

const isFinding = (entry: unknown): entry is Finding =>
  typeof entry === 'object' && entry !== null && 'summary' in entry;

/**
 * A fenced block into findings, keeping the entries that parsed.
 *
 * `every` rather than `some` used to decide this, which meant one malformed
 * entry threw away the whole block: five findings where the last was truncated
 * mid-object became no findings at all, and the raw JSON went into the review
 * body as prose. Dropping the one bad entry loses strictly less.
 *
 * `some` rather than `every` is still doing the work `every` was there for,
 * which is telling a findings array apart from any other JSON array the model
 * might emit. An empty array is exempt because that is the clean review signal
 * and has no entry to recognise; `buildReview` handles the difference between
 * an empty array and no array at all.
 */
const parseFindings = (block: string): readonly Finding[] | undefined => {
  const body = block.trim();
  if (!body.startsWith('[')) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed)) return undefined;
    if (parsed.length > 0 && !parsed.some(isFinding)) return undefined;
    return parsed.filter(isFinding);
  } catch {
    return undefined;
  }
};

const findingsIn = (text: string): readonly Finding[] | undefined => {
  const fenced = [...text.matchAll(FENCE)].map((match) => match[1] ?? '');
  const lists = (fenced.length > 0 ? fenced : [text])
    .map(parseFindings)
    .filter((list): list is readonly Finding[] => list !== undefined);
  return lists.length === 0 ? undefined : lists.flat();
};

/**
 * A message that is nothing but an empty list is a clean review. An illustrative
 * empty fence inside a real write-up is not: `Array.prototype.every` is vacuously
 * true on `[]`, which once approved a pull request the reviewer had written up.
 */
const proseOutside = (text: string): string => {
  const withoutFences = text.replace(FENCE, '').trim();
  return withoutFences === text.trim() && parseFindings(text) !== undefined
    ? ''
    : withoutFences;
};

const detail = (finding: Finding): string => {
  const parts: string[] = [];
  if (finding.summary !== undefined) parts.push(finding.summary);
  if (finding.failure_scenario !== undefined) {
    parts.push(`**How it fails:** ${finding.failure_scenario}`);
  }
  return parts.join('\n\n');
};

const at = (finding: Finding): string =>
  finding.file === undefined
    ? 'elsewhere'
    : `\`${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}\``;

/**
 * GitHub rejects the whole review if any comment names a line outside the diff, so
 * a finding about an untouched line is summarised in the body instead of dropped.
 */
export const buildReview = (
  result: string,
  commentable: Commentable,
): Review => {
  const findings = findingsIn(result);
  const sentinel = verdictIn(result);
  const clean =
    findings !== undefined &&
    findings.length === 0 &&
    proseOutside(result) === '';

  /**
   * Approving needs both signals to agree. The sentinel alone would approve a
   * review that listed five findings and ended `VERDICT: APPROVE`, and the list
   * alone was already shown to approve on a stray empty fence. Either one saying
   * there is something to fix is enough to withhold the approval.
   */
  const nothingFound = findings === undefined ? false : findings.length === 0;
  const event: Review['event'] =
    sentinel === 'COMMENT' || (findings !== undefined && !nothingFound)
      ? 'COMMENT'
      : sentinel === 'APPROVE' || clean
        ? 'APPROVE'
        : 'COMMENT';

  // Prose, so there is nothing to anchor: it goes in the body. An empty list that
  // is not the whole message lands here too, or a write-up carrying an
  // illustrative empty fence would be summarised away as a clean review.
  if (findings === undefined || (findings.length === 0 && !clean)) {
    return { event, body: withoutVerdict(result), comments: [] };
  }
  if (findings.length === 0) {
    return {
      event,
      body: 'Reviewed the diff and found nothing worth changing.',
      comments: [],
    };
  }

  const comments: ReviewComment[] = [];
  const elsewhere: Finding[] = [];

  for (const finding of findings) {
    const lines =
      finding.file === undefined ? undefined : commentable.get(finding.file);
    if (
      finding.file !== undefined &&
      finding.line !== undefined &&
      lines?.has(finding.line) === true
    ) {
      comments.push({
        path: finding.file,
        line: finding.line,
        side: 'RIGHT',
        body: detail(finding),
      });
    } else {
      elsewhere.push(finding);
    }
  }

  const plural = findings.length === 1 ? 'comment' : 'comments';
  const body = [`**Actionable ${plural} posted: ${comments.length}**`];

  if (elsewhere.length > 0) {
    // Collapsed, so the conversation stays a summary rather than the review.
    body.push(
      '',
      `<details><summary>Outside the diff (${elsewhere.length})</summary>`,
      '',
      ...elsewhere.map(
        (finding) =>
          `- ${at(finding)} ${finding.short_summary ?? finding.summary ?? ''}`,
      ),
      '',
      '</details>',
    );
  }

  return { event, body: body.join('\n'), comments };
};

/** `@@ -a,b +c,d @@` then one line per row, counting only the right-hand side. */
export const commentableLines = (
  files: readonly { readonly filename: string; readonly patch?: string }[],
): Commentable => {
  const map = new Map<string, Set<number>>();

  for (const file of files) {
    if (file.patch === undefined) continue;
    const lines = new Set<number>();
    let cursor = 0;

    for (const row of file.patch.split('\n')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
      if (hunk) {
        cursor = Number(hunk[1]);
        continue;
      }
      if (row.startsWith('-')) continue;
      if (row.startsWith('+') || row.startsWith(' ')) {
        lines.add(cursor);
        cursor += 1;
      }
    }
    map.set(file.filename, lines);
  }

  return map;
};

const gh = async (args: readonly string[]): Promise<string> => {
  const proc = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh ${args.join(' ')} failed: ${err.trim()}`);
  return out;
};

if (import.meta.main) {
  const [executionFile, repo, number, reviewed] = Bun.argv.slice(2);
  if (
    executionFile === undefined ||
    repo === undefined ||
    number === undefined ||
    reviewed === undefined
  ) {
    console.error(
      'Usage: bun scripts/post-review.ts <execution-file> <owner/repo> <number> <reviewed-sha>',
    );
    process.exit(2);
  }

  const result = resultOf(await Bun.file(executionFile).text());
  if (result.trim() === '') {
    console.error('The reviewer produced no review. Not posting an empty one.');
    process.exit(1);
  }

  /**
   * A push during the run moves the head, and a review posted against the new one
   * attaches findings to lines that were read from the old one. `concurrency`
   * cancels a superseded run, but not reliably before it reaches this point.
   * Being superseded is not a failure, so this exits 0.
   */
  const head = (
    await gh(['api', `repos/${repo}/pulls/${number}`, '--jq', '.head.sha'])
  ).trim();
  if (head !== reviewed) {
    console.log(
      `Head moved from ${reviewed.slice(0, 7)} to ${head.slice(0, 7)} during the run. Not posting a review of the commit before it.`,
    );
    process.exit(0);
  }

  const files = JSON.parse(
    await gh(['api', '--paginate', `repos/${repo}/pulls/${number}/files`]),
  ) as { filename: string; patch?: string }[];

  const review = buildReview(result, commentableLines(files));
  if (review.body === '' && review.comments.length === 0) {
    console.error('The reviewer produced no review. Not posting an empty one.');
    process.exit(1);
  }

  const payload = JSON.stringify({ commit_id: reviewed, ...review });
  const proc = Bun.spawn(
    [
      'gh',
      'api',
      '--method',
      'POST',
      `repos/${repo}/pulls/${number}/reviews`,
      '--input',
      '-',
    ],
    {
      stdin: new TextEncoder().encode(payload),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [err, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    console.error(`Posting the review failed: ${err.trim()}`);
    process.exit(1);
  }

  console.log(
    `${review.event.toLowerCase()}: ${review.comments.length} inline, ${
      review.body.length
    } bytes of body`,
  );
}
