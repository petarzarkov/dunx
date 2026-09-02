import { parseOptions, usage } from './cli.js';
import { selectGenerator } from './loadgen/index.js';
import { formatReport } from './report.js';
import { runSuite } from './run.js';

const options = parseOptions(process.argv.slice(2));
if (options === null) {
  console.log(usage);
  process.exit(0);
}

const generator = await selectGenerator(options.loadgen, options.allowFallback);
if (generator.id === 'fetch' && options.loadgen === 'auto') {
  process.stderr.write(
    'No oha binary found, falling back to the JavaScript fetch driver.\n' +
      'It is slower than a native generator and can cap the fastest subjects.\n' +
      'Run `bun run setup` to install oha, or set BENCH_OHA.\n',
  );
}

const report = await runSuite(
  options.subjects,
  options.scenarios,
  generator,
  options.config,
  options.nodeBinary,
  options.profile === undefined
    ? undefined
    : { kind: options.profile, dir: options.profileDir },
);

if (options.profile !== undefined) {
  // "requested", not "written": only a Bun subject takes the flags, and a
  // subject that ignores SIGTERM falls back to SIGKILL and writes nothing. The
  // directory is the honest thing to report.
  process.stderr.write(
    `\n${options.profile} profiling requested; any profiles are in ${options.profileDir}\n`,
  );
}

await Bun.write(options.out, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`\n${formatReport(report)}`);
process.stderr.write(`\nJSON report written to ${options.out}\n`);
