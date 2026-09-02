/**
 * Installs the git hooks, replacing husky.
 *
 * husky was two things: a `prepare` script that pointed `core.hooksPath` at
 * `.husky/`, and the hook files themselves. `core.hooksPath` is what broke hooks
 * in a linked worktree - the path is relative and `.husky/_` is gitignored, so
 * git found no hooks there and skipped them silently. Writing into the
 * repository's real hooks directory does not have that problem: git resolves it
 * from the **common** dir, which every linked worktree shares.
 *
 * Run by `prepare`, so `bun install` installs the hooks.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const git = (...args: string[]): string =>
  Bun.spawnSync(['git', ...args])
    .stdout.toString()
    .trim();

/**
 * `--git-common-dir` rather than `--git-dir`: in a linked worktree the latter is
 * `.git/worktrees/<name>`, which has no hooks of its own.
 */
const commonDir = git('rev-parse', '--git-common-dir');
if (commonDir === '') {
  console.log('install-hooks: not a git repository, nothing to install');
  process.exit(0);
}

const root = git('rev-parse', '--show-toplevel');
const hooks = join(
  commonDir === '.git' ? join(root, '.git') : commonDir,
  'hooks',
);

/**
 * Resolved when the hook runs rather than baked in, so the file survives the
 * repository being moved or cloned to another path.
 */
const BIN = '"$(git rev-parse --show-toplevel)/node_modules/.bin"';

const PRE_COMMIT = `#!/usr/bin/env sh
# Managed by scripts/install-hooks.ts. Edit that, not this.
#
# stagelint runs oxlint and oxfmt over the staged files per .stagelint.yml. It
# three-way merges a formatter's rewrite into a partially staged file, so an
# unstaged edit in the same file no longer blocks the commit the way lint-staged
# did.
#
# The bin directory goes on PATH because stagelint execs its commands directly
# rather than through a shell that would resolve them: without this every task
# fails with "No such file or directory". It keeps .stagelint.yml readable as
# bare binary names.
PATH="$(git rev-parse --show-toplevel)/node_modules/.bin:$PATH"
export PATH
exec ${BIN}/stagelint "$@"
`;

const PRE_PUSH = `#!/usr/bin/env sh
# Managed by scripts/install-hooks.ts. Edit that, not this.
#
# pre-commit only sees staged files, so an unformatted file can still reach CI
# and fail \`bun run format:check\`. Catch it here instead.
unformatted=$(${BIN}/oxfmt --list-different .)

[ -z "$unformatted" ] && exit 0

${BIN}/oxfmt --write . >/dev/null

echo "pre-push: these files were not formatted, and CI would have failed on them:"
echo "$unformatted" | sed 's/^/  /'
echo ""
echo "oxfmt has now fixed them in your working tree. Commit the change, then push again."
exit 1
`;

if (!existsSync(hooks)) mkdirSync(hooks, { recursive: true });

for (const [name, body] of [
  ['pre-commit', PRE_COMMIT],
  ['pre-push', PRE_PUSH],
] as const) {
  const path = join(hooks, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// husky set this; leaving it pointed at a directory that no longer exists would
// disable every hook.
if (git('config', '--get', 'core.hooksPath') !== '') {
  Bun.spawnSync(['git', 'config', '--unset', 'core.hooksPath']);
}

console.log(`install-hooks: pre-commit and pre-push -> ${hooks}`);
