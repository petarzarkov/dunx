import { parseOptions, usage } from './cli.js';
import { selectGenerator } from './loadgen/index.js';
import { formatReport } from './report.js';
import { runSuite } from './run.js';

const options = parseOptions(process.argv.slice(2));
if (options === null) {
  console.log(usage);
  process.exit(0);
}

const generator = await selectGenerator(options.loadgen);
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
);

await Bun.write(options.out, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`\n${formatReport(report)}`);
process.stderr.write(`\nJSON report written to ${options.out}\n`);
