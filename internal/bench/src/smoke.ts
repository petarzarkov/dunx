/**
 * Does every subject start, and does it answer every scenario with the bytes the
 * contract in `src/scenarios.ts` demands? No load, no timing, one process at a
 * time.
 *
 * This is the check to run before a measured suite and after touching any server
 * file. `bun run start` verifies the same contract, but it does so per scenario
 * with every subject already up, so a subject that fails to build is 40 minutes of
 * measurement away from saying so.
 *
 * ```bash
 * bun run smoke
 * bun run smoke --subjects dunx,bun-serve
 * ```
 *
 * Exit code is the number of subjects that failed, capped at 1: a toolchain that
 * is absent is a skip and not a failure, the same way it is in the measured suite.
 */
import { parseArgs } from 'node:util';
import { note } from './driver.js';
import { ioEnvFor, planIo } from './io-fixture.js';
import { readMachine } from './machine.js';
import { prepare } from './run.js';
import { scenarios } from './scenarios.js';
import { subjects } from './subjects.js';
import { startSubject, verifySubject } from './subject-process.js';
import type { Subject } from './types.js';

const usage = `bun run smoke [options]

  --subjects <a,b>    comma-separated subject ids (default all)
  --scenarios <a,b>   comma-separated scenario ids (default all)
  --help

  Subjects:  ${subjects.map((subject) => subject.id).join(', ')}
  Scenarios: ${scenarios.map((scenario) => scenario.id).join(', ')}
`;

const pick = <T extends { readonly id: string }>(
  all: readonly T[],
  raw: string | undefined,
  kind: string,
): readonly T[] => {
  if (raw === undefined) return all;
  return raw.split(',').map((id) => {
    const found = all.find((entry) => entry.id === id.trim());
    if (found === undefined) {
      throw new Error(
        `Unknown ${kind} "${id}". Known: ${all.map((e) => e.id).join(', ')}`,
      );
    }
    return found;
  });
};

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    subjects: { type: 'string' },
    scenarios: { type: 'string' },
    help: { type: 'boolean' },
  },
  strict: true,
});

if (values.help === true) {
  console.log(usage);
  process.exit(0);
}

const chosen = pick(subjects, values.subjects, 'subject');
// One subject is up at a time here, so the connection budget is one pool.
const plan = await planIo(pick(scenarios, values.scenarios, 'scenario'), 1);
if (plan.note !== null) note(plan.note);
const wanted = plan.scenarios;
const nodeBinary = process.env['BENCH_NODE'] ?? 'node';
const machine = await readMachine(nodeBinary);

const { runnable, exec } = await prepare(
  chosen,
  nodeBinary,
  machine.node !== 'not found',
);

/**
 * One process per scenario, the way the measured suite does it, rather than one
 * process answering all of them. The `io` scenario is the reason: its subjects
 * connect to Redis and Postgres at boot and only when the harness passes the
 * URLs, so a single process could not check both the connected and the
 * unconnected shape.
 */
const check = async (subject: Subject): Promise<void> => {
  for (const scenario of wanted) {
    const server = await startSubject(
      subject,
      exec.get(subject.id) ?? [],
      ioEnvFor(scenario, plan.services),
    );
    try {
      await verifySubject(subject, server.baseUrl, [scenario]);
    } finally {
      await server.stop();
    }
  }
};

const failures: { subject: Subject; reason: string }[] = [];

note(
  `\nsmoke: ${runnable.length} of ${chosen.length} subjects, ` +
    `${wanted.length} scenarios each\n`,
);

for (const subject of runnable) {
  const label = subject.label.padEnd(46);
  try {
    await check(subject);
    note(`ok    ${label} ${wanted.map((one) => one.id).join(' ')}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failures.push({ subject, reason });
    note(`FAIL  ${label} ${reason.split('\n')[0] ?? ''}`);
  }
}

const skipped = chosen.filter(
  (subject) => !runnable.some((one) => one.id === subject.id),
);
if (skipped.length > 0) {
  note(`\nskipped (toolchain absent): ${skipped.map((s) => s.id).join(', ')}`);
}

if (failures.length > 0) {
  note(`\n${failures.length} subject(s) failed:\n`);
  for (const failure of failures) {
    note(`${failure.subject.id}\n${failure.reason}\n`);
  }
  process.exit(1);
}

note(`\nAll ${runnable.length} runnable subjects answered every scenario.`);
