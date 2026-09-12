/**
 * Posts a `/code-review` run as one pull request review: a short summary, and each
 * finding as an inline comment on the line it is about.
 *
 * `bun scripts/post-review.ts <execution-file> <owner/repo> <number> <sha> [--whole-diff]`
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

/**
 * The files this review is allowed to report on, or `null` for all of them.
 *
 * `null` is the first review of a pull request, which sees the whole diff. Every
 * review after it sees only the files touched since the previous one.
 *
 * **This is what lets a pull request converge.** The reviewer runs against the
 * full diff on every push and is not deterministic over it, so unchanged code
 * gets a fresh chance to yield a finding on each run. Measured on #70: round 3
 * reported `rssMeanMiB` in `src/resources.ts` and a duplicated `Row` in
 * `servers/drivers/pair.ts`, and `git log` shows neither file was touched between
 * the first push and the commit that round reviewed. Both findings were equally
 * true and equally reportable in round 1. Five rounds, 24 findings, and never an
 * approval, because there was always something new to say about code nobody had
 * changed.
 *
 * Findings outside the scope are counted in the body rather than dropped in
 * silence: they were reportable earlier and are still true, and hiding them would
 * be this script deciding what the author may see.
 */
export type Scope = ReadonlySet<string> | null;

/**
 * GitHub's compare endpoint returns at most this many files and does not page
 * past them, so a longer list has been silently truncated.
 */
export const COMPARE_FILE_CAP = 300;

/**
 * The scope a compare result supports, or `null` when it cannot be trusted to be
 * complete.
 *
 * Suppressing a finding because its file fell off the end of a truncated list is
 * the exact failure this scoping exists to prevent: a genuinely new problem,
 * filed under "not repeated here", on a review that could then approve.
 *
 * Being wrong about the cap is safe in the direction that matters - too low
 * reviews more than it needs to, and only too high could suppress.
 */
export const scopeFromCompare = (touched: readonly string[]): Scope =>
  touched.length >= COMPARE_FILE_CAP ? null : new Set(touched);

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

const parseFindings = (block: string): readonly Finding[] | undefined => {
  const body = block.trim();
  if (!body.startsWith('[')) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed)) return undefined;
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
  scope: Scope = null,
): Review => {
  const all = findingsIn(result);
  const findings =
    all === undefined || scope === null
      ? all
      : all.filter(
          (finding) => finding.file === undefined || scope.has(finding.file),
        );
  const carried = (all?.length ?? 0) - (findings?.length ?? 0);
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
      body:
        carried === 0
          ? 'Reviewed the diff and found nothing worth changing.'
          : `Reviewed what changed since the last review and found nothing worth changing.\n\n${carriedNote(carried)}`,
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

  if (carried > 0) body.push('', carriedNote(carried));

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

/**
 * Said plainly rather than hidden: these findings are real, they are just not
 * about anything this push touched, so repeating them as new inline comments on
 * every round is what turns a review into a treadmill.
 */
const carriedNote = (carried: number): string =>
  `${carried} further finding${carried === 1 ? '' : 's'} ` +
  `${carried === 1 ? 'is' : 'are'} in code untouched since the last review, ` +
  'and so were reportable then. Not repeated here.';

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

/**
 * The commit this reviewer last posted a review against on this pull request, or
 * `undefined` if this is the first.
 *
 * By the authenticated account rather than a hardcoded login: the workflow runs
 * as whatever `DUNXONU_TOKEN` belongs to, and a review left by a human or by
 * another bot must not narrow what this one looks at.
 */
const lastReviewedSha = async (
  repo: string,
  number: string,
): Promise<string | undefined> => {
  const me = (await gh(['api', 'user', '--jq', '.login'])).trim();
  const reviews = JSON.parse(
    await gh(['api', '--paginate', `repos/${repo}/pulls/${number}/reviews`]),
  ) as { user?: { login?: string }; commit_id?: string }[];
  return reviews.findLast((review) => review.user?.login === me)?.commit_id;
};

/**
 * The files touched since this reviewer last looked, or `null` when it has not.
 *
 * Both failure modes here widen rather than narrow. A `compare` that throws -
 * the old commit garbage-collected after a force-push, most likely - and a
 * response at the file cap both fall back to the whole diff. Reviewing too much
 * is the behaviour being fixed; reviewing nothing silently would be worse than
 * the bug.
 */
const scopeSince = async (
  repo: string,
  number: string,
  head: string,
): Promise<Scope> => {
  const since = await lastReviewedSha(repo, number);
  if (since === undefined || since === head) return null;
  try {
    const compared = JSON.parse(
      await gh(['api', `repos/${repo}/compare/${since}...${head}`]),
    ) as { files?: { filename: string }[] };
    const touched = compared.files?.map((file) => file.filename) ?? [];
    const scope = scopeFromCompare(touched);
    console.log(
      scope === null
        ? `Compare returned ${touched.length} files, at or past the ${COMPARE_FILE_CAP} the API caps at, so the list may be short. Reviewing the whole diff.`
        : `Reviewing ${touched.length} file(s) changed since ${since.slice(0, 7)}.`,
    );
    return scope;
  } catch (error) {
    console.log(
      `Could not compare ${since.slice(0, 7)}...${head.slice(0, 7)}, reviewing the whole diff: ${String(error)}`,
    );
    return null;
  }
};

if (import.meta.main) {
  /**
   * `--whole-diff` turns the narrowing off, and an on-demand review always
   * passes it.
   *
   * The narrowing asks what this **account** last reviewed, and dunxonu now
   * reviews every push through `fast-code-review`. So a deep review asked for
   * by name would scope itself to whatever changed since that automatic review
   * ran, which is usually nothing, and report nothing: the one review somebody
   * explicitly requested would be the one that looked at the least.
   *
   * Convergence is not the point here either. Nobody types the trigger twice by
   * accident, so there is no treadmill to prevent.
   */
  const wholeDiff = Bun.argv.includes('--whole-diff');
  const [executionFile, repo, number, reviewed] = Bun.argv
    .slice(2)
    .filter((argument) => !argument.startsWith('--'));
  if (
    executionFile === undefined ||
    repo === undefined ||
    number === undefined ||
    reviewed === undefined
  ) {
    console.error(
      'Usage: bun scripts/post-review.ts <execution-file> <owner/repo> <number> <reviewed-sha> [--whole-diff]',
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

  const review = buildReview(
    result,
    commentableLines(files),
    wholeDiff ? null : await scopeSince(repo, number, head),
  );
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
