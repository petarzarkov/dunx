import type { Feature } from './features.js';

/**
 * `AGENTS.md` and `CLAUDE.md` for the scaffolded app.
 *
 * An agent starting on a fresh dunx app has to be told the things the framework
 * fails at boot over: constructor injection needs the preload line, there is no
 * `@Injectable()` to add, and a `import type` at an injection site is an error
 * rather than an `undefined`. Everything here is app-scoped; the framework's own
 * instructions stay at one URL so they are current rather than a copy frozen at
 * scaffold time.
 *
 * `CLAUDE.md` is a pointer, not a second copy. Claude Code resolves an `@path`
 * import, and the sentence above it says where to look for a tool that does not.
 */
const SETUP_URL = 'https://dunx.win/setup.md';
const LLMS_URL = 'https://dunx.win/llms.txt';

const CLAUDE_POINTER = `# CLAUDE.md

The instructions for this application live in \`AGENTS.md\`, imported below so every
agent reads one file.

@AGENTS.md
`;

const RULES = `## Rules that produce a boot error when broken

- **No \`@Injectable()\`, no \`@Inject()\`.** Listing a class in a module's
  \`providers\` is what makes it injectable. dunx uses TC39 standard decorators,
  which have no parameter decorators. For a value with no constructor parameter to
  hang off, use \`inject(Token)\` in a field initializer.
- **Do not add \`reflect-metadata\`, \`experimentalDecorators\` or
  \`emitDecoratorMetadata\`.** \`bunfig.toml\` preloads \`@dunx/transform\`, which
  records each class's constructor parameter types. Removing that line makes every
  provider fail at boot.
- **A constructor parameter whose type is erased fails at boot, naming the
  parameter.** An interface, a primitive, a union, a class type parameter, or a
  \`import type\` at an injection site all record as \`unresolved\`. Inject a class,
  and drop \`type\` from the import.
- **Relative imports carry \`.js\`**: \`'./users.service.js'\`, never
  \`'./users.service'\`.
- **A module's \`exports\` is its public surface.** The container is scoped per
  module, so a provider another module injects has to be exported by the module that
  declares it.
- **\`bun\` only.** No \`npm\`, \`npx\`, \`yarn\` or \`pnpm\`; run tools with \`bunx\`.
`;

const layout = (features: readonly Feature[]): string =>
  features.length === 0
    ? `- \`src/main.ts\` - the entry point
- \`src/app.module.ts\` - the root module; \`controllers\` get routes, \`providers\` do not
- \`src/greetings.controller.ts\`, \`src/greetings.service.ts\` - one route and its provider
- \`src/app.test.ts\` - the whole app behind a real server on port 0
- \`bunfig.toml\` - the preload line constructor injection needs
`
    : `- \`src/main.ts\` - exports \`createApp\`, and serves it when run directly
- \`src/app.module.ts\` - the root module, importing every feature
- \`src/config.ts\` - one validation function, flat env in and a shaped object out
${features.map((feature) => `- \`src/${feature.source}/\` - ${feature.name}`).join('\n')}
- \`bunfig.toml\` - the preload line constructor injection needs

\`main.ts\`, \`app.module.ts\` and \`config.ts\` were generated for the features chosen
at scaffold time. Everything else was copied from dunx's \`examples/full\`. The
\`*.demo.ts\` files are that example's scripted walkthroughs; delete one and its
\`providers\` entry to drop it.

A test imports \`createApp\` from \`./main.js\`; the \`import.meta.main\` block at the
bottom is what stops that starting a server.
`;

export const agents = (name: string, features: readonly Feature[]): string => {
  const services = features.filter((feature) => feature.service !== undefined);
  const hasJobs = features.some((feature) => feature.name === 'jobs');

  return `# ${name}

Notes for an agent working in this application. It is a
[dunx](https://github.com/petarzarkov/dunx) app, scaffolded by
\`bunx @dunx/create-app\`.

## Commands

\`\`\`bash
bun install
bun run dev          # http://localhost:3000, restarting on a change
bun run start
bun test
bun run typecheck
\`\`\`${
    hasJobs
      ? `

**There is no worker command.** \`QueueModule\` is given \`consume: true\`, so the
container opens the workers at \`onInit\` and closes them before the connections they
use. A handler marked \`background: true\` is forked by bullmq into
\`src/jobs/jobs.processor.ts\`, which nobody runs by hand.`
      : ''
  }

## Layout

${layout(features)}
${
  features.length === 0
    ? ''
    : `## What is wired up

${features.map((feature) => `- **${feature.name}** - ${feature.summary}`).join('\n')}

`
}${
    services.length === 0
      ? ''
      : `## Services

Each of these reports itself degraded rather than failing the boot, so the app
starts without them.

${services.map((feature) => `- **${feature.name}** needs ${feature.service}`).join('\n')}

`
  }${RULES}
## Reading this app instead of grepping it

\`\`\`bash
bunx @dunx/mcp ./src/app.module.ts
\`\`\`

An MCP server over stdio answering what routes, providers, modules and gateways
exist, and which constructor parameters would fail to resolve. It reads the module
graph and never boots the app.

## The framework's own instructions

- <${SETUP_URL}> - installing, wiring and verifying a dunx app
- <${LLMS_URL}> - every dunx document, as raw markdown
`;
};

/** Both files, written for a fixed template and a composed app alike. */
export const agentFiles = (
  name: string,
  features: readonly Feature[],
): Readonly<Record<string, string>> => ({
  'AGENTS.md': agents(name, features),
  'CLAUDE.md': CLAUDE_POINTER,
});
