import { AppFactory, Logger } from '@dunx/core';
import { CLI_NAME, CLI_VERSION } from './config/settings.js';
import { CliModule } from './cli.module.js';
import { GreeterService } from './greeter/greeter.service.js';
import { ReportService } from './report/report.service.js';

const USAGE = `${CLI_NAME} ${CLI_VERSION}

A dunx app compiled to a single self-contained executable.

Usage:
  ${CLI_NAME} greet <name>   Greet someone (JSON on stdout, log on stderr)
  ${CLI_NAME} report         Print this binary's runtime report as JSON
  ${CLI_NAME} version        Print the version and exit
  ${CLI_NAME} help           Print this help

Logs go to stderr so stdout carries the JSON alone, which is what makes the
output parseable: \`${CLI_NAME} report | jq .version\`.
`;

/**
 * `version` and `help` answer before the container is built, on purpose: they
 * cannot fail, so a caller asking a broken binary its version still gets one.
 * Everything else boots the same container a server would.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const command = argv.find((arg) => !arg.startsWith('-')) ?? 'help';

  if (command === 'version') {
    console.log(CLI_VERSION);
    return 0;
  }
  if (command === 'help' || argv.includes('--help')) {
    console.log(USAGE);
    return 0;
  }

  const app = await AppFactory.create(CliModule);
  const logger = app.get(Logger);
  try {
    switch (command) {
      case 'greet': {
        const name = argv.find(
          (arg) => !arg.startsWith('-') && arg !== 'greet',
        );
        if (name === undefined) {
          console.error('greet needs a name: `pulse greet ada`');
          return 1;
        }
        console.log(JSON.stringify(app.get(GreeterService).greet(name)));
        return 0;
      }

      case 'report':
        console.log(JSON.stringify(app.get(ReportService).collect(), null, 2));
        return 0;

      default:
        console.error(`Unknown command "${command}"\n\n${USAGE}`);
        return 1;
    }
  } catch (error) {
    logger.error('command failed', {
      command,
      err: error instanceof Error ? error.message : String(error),
    });
    return 1;
  } finally {
    await app.shutdown();
  }
};

// False when a test imports this file for `run`, which is what lets one module be
// both the entry point and the app's definition.
if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}
