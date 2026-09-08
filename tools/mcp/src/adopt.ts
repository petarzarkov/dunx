import { Args, bool, NO_ARGS, schema, str } from './args.js';
import { GUIDE, MINIMAL, SCAFFOLD } from './generated.js';
import { Guide } from './guide.js';
import type { ToolDefinition } from './protocol.js';
import { Scaffold } from './scaffold.js';

/**
 * The tools that answer without an app. `toolsFor` reads a module graph and so
 * needs one; everything here ships its answer in the package, which is what lets
 * `bunx @dunx/mcp` with no entry still be worth wiring into a client.
 */
const guide = new Guide(GUIDE);
const scaffold = new Scaffold(SCAFFOLD, MINIMAL);

/**
 * The four things an agent writing dunx gets wrong with no compiler to stop it.
 * Each one is a boot error or a resolution failure rather than a preference, and
 * each is asserted against the repo in `adopt.test.ts` so it cannot rot into
 * advice that used to be true.
 */
const RULES: readonly { readonly rule: string; readonly detail: string }[] = [
  {
    rule: 'Constructor injection needs the preload.',
    detail:
      'Add `preload = ["@dunx/transform/preload"]` to bunfig.toml, and again under `[test]`. It records each class\'s constructor parameter types at load time. Without it a class with constructor parameters is a boot error naming the preload.',
  },
  {
    rule: 'There are no parameter decorators.',
    detail:
      'dunx uses TC39 standard decorators, which have none, so `@Inject()` does not exist. A parameter whose type is erased - an interface, a primitive, a union, a type-only import - is recorded as unresolved and fails at boot naming that parameter. Use a class as the type, or `inject(TOKEN)` in a field initializer.',
  },
  {
    rule: 'Relative imports carry a .js extension.',
    detail:
      '`import { UsersService } from \'./users.service.js\'`. The manifest is `"type": "module"` and resolution is nodenext, so an extensionless relative specifier does not resolve.',
  },
  {
    rule: 'Modules encapsulate.',
    detail:
      'A module reference is a scope holding what it declares. `exports` is its public surface and absent means nothing is exported; `global: true` publishes those exports app-wide. Importing a module is what makes its exports resolvable, not declaring a provider anywhere in the app.',
  },
];

export const adoptionTools = (): readonly ToolDefinition[] => [
  {
    name: 'dunx_start',
    description:
      'Read this first when writing or adopting dunx. The runtime it needs, the two ways to get an app (scaffold, or add dunx to an existing project), the rules that are boot errors rather than preferences, and the index of the written guide. Answers with no app present, so it is the call to make before there is anything for the other tools to read.',
    inputSchema: NO_ARGS,
    run: () => ({
      runtime: scaffold.starter().runtime,
      scaffold: {
        command: 'bunx @dunx/create-app my-api',
        detail:
          'Asks which features to include and writes them. Piped or in CI it asks nothing and writes the minimal template. Call dunx_scaffold for the feature list.',
      },
      addToExistingProject: {
        commands: scaffold.steps(),
        bunfig: scaffold.bunfig(),
      },
      rules: RULES,
      guide: guide.titles(),
      thenCall: {
        dunx_guide:
          "A chapter in full, a search across all of them, or the index with each chapter's summary and section headings.",
        dunx_scaffold:
          'What bunx @dunx/create-app can generate, and the smallest app it generates.',
        dunx_overview:
          'Once an app exists and this server was given its root module.',
      },
    }),
  },
  {
    name: 'dunx_guide',
    description: `The written guide, bundled in this package: ${GUIDE.length} chapters covering providers, modules, controllers, validation, lifecycle, middleware and guards, websockets, OpenAPI, testing, configuration, logging, database, queues, scheduling, authentication, files, deployment, health checks and metrics. No arguments returns the index. \`topic\` returns one chapter in full; \`search\` returns matching lines across every chapter, which is the cheaper first call when the question does not name a chapter.`,
    inputSchema: schema({
      topic: str(
        'One chapter, by slug (06-validation) or by name (validation). Returns the whole chapter.',
      ),
      search: str(
        'Matching lines across every chapter, with the chapter and line number of each. Takes precedence over `topic` when both are given.',
      ),
    }),
    run: (raw) => {
      const args = new Args(raw);
      const search = args.text('search');
      const topic = args.text('topic');
      if (search !== undefined) {
        return {
          query: search,
          ...guide.search(search),
          ...(topic === undefined
            ? {}
            : {
                note: `\`topic\` was ignored: \`search\` takes precedence. Call again with only \`topic: "${topic}"\` for the chapter itself.`,
              }),
        };
      }

      if (topic === undefined) return { chapters: guide.index() };

      const chapter = guide.chapter(topic);
      if (chapter === undefined) {
        const candidates = guide.candidates(topic);
        return candidates.length > 1
          ? {
              error: `"${topic}" matches ${candidates.length} chapters. Call again with one of them.`,
              candidates,
            }
          : {
              error: `No chapter matches "${topic}".`,
              chapters: guide.index().map((entry) => entry.slug),
            };
      }
      return {
        chapter,
        otherMatches: guide
          .candidates(topic)
          .filter((slug) => slug !== chapter.slug),
      };
    },
  },
  {
    name: 'dunx_scaffold',
    description:
      'What `bunx @dunx/create-app` can generate: every feature, what it demonstrates, the features it pulls in with it, the dependencies it adds, and the backing service it needs to do anything. `starter: true` also returns the source of the smallest working app, which is what to copy when adding dunx to a project that already exists. Writes nothing.',
    inputSchema: schema({
      feature: str('Only features whose name contains this.'),
      starter: bool(
        'Include the source of the minimal app: five TypeScript files, one route, plus bunfig.toml and tsconfig.json.',
      ),
    }),
    run: (raw) => {
      const args = new Args(raw);
      const features = scaffold.features(args.text('feature'));
      return args.flag('starter')
        ? { features, starter: scaffold.starter() }
        : { features };
    },
  },
];

/** The guide chapters as MCP resources, for a client that attaches documents. */
export const adoptionResources = (): ReturnType<Guide['resources']> =>
  guide.resources();
