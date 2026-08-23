/**
 * What dunx is, written once.
 *
 * The README's opening and the documentation site's hero say the same thing to
 * the same reader, and they were two hand-maintained copies that drifted inside a
 * single release: the README led with the bundle while the site still led with
 * dependency injection and a throughput panel.
 *
 * So this is the source and both are generated from it. `scripts/update-readme.ts`
 * writes the README between its markers, `internal/docs/scripts/generate.ts` puts
 * it in the site model, and `--check` fails CI on drift.
 *
 * It lives in `scripts/` because that is what the README generator already reads
 * and what the root tsconfig already covers; the site imports it by relative path,
 * the way `internal/dashboard-ui` reads its payload types straight out of the
 * package sources.
 */

/**
 * The headline, in two lines. The site sets the second in the gradient and the
 * README joins them, so there is one sentence rather than two spellings of it.
 */
export const HEADLINE: readonly [string, string] = [
  'Everything a service needs.',
  'On Bun. One version.',
];

/** The bundle, as prose. Rendered verbatim in both places. */
export const BLURB =
  'Controllers, dependency injection, validation, OpenAPI, WebSockets, queues, ' +
  'an ORM, auth, a test harness and an ops dashboard. Released together, tested ' +
  "together, on Bun's own primitives.";

/** The hero's three chips. The README carries the same claims in its badge row. */
export const CHIPS: readonly string[] = [
  'Bun-native',
  'one version number',
  'zero-dependency core',
];

/**
 * What a reader is shopping for, against what dunx hands them. The README renders
 * it as a table; the site does not render it yet, and having it here is what makes
 * adding that section a read rather than a retype.
 */
export interface Capability {
  readonly need: string;
  readonly gives: string;
}

export const CAPABILITIES: readonly Capability[] = [
  {
    need: 'Structure',
    gives: 'Controllers, scoped modules, constructor DI, lifecycle hooks',
  },
  {
    need: 'Requests',
    gives:
      '`Bun.serve` routing, middleware, guards, CORS, compression, throttling',
  },
  {
    need: 'Validation',
    gives: 'Standard Schema, so zod, Valibot or ArkType all drop in',
  },
  {
    need: 'API documentation',
    gives:
      'OpenAPI 3.1 from the schemas the routes already validate, Swagger UI',
  },
  {
    need: 'Realtime',
    gives:
      'WebSocket gateways on the same port, with a Redis relay for many nodes',
  },
  {
    need: 'Data',
    gives:
      'drizzle over `bun:sqlite` and `Bun.SQL`, transactions, seeds, paging',
  },
  {
    need: 'Background work',
    gives: 'bullmq over `Bun.RedisClient`, sandboxed processors, `@Cron`',
  },
  {
    need: 'Storage and images',
    gives:
      'One `Storage` contract over `Bun.file` and `Bun.S3Client`, `Bun.Image`',
  },
  {
    need: 'Auth',
    gives: 'better-auth mounted, a session guard, `Bun.password` hashing',
  },
  {
    need: 'Calling out',
    gives: 'An HTTP client with retry, backoff and trace propagation',
  },
  {
    need: 'Operating it',
    gives: 'Health checks, structured logging, an ops dashboard, bull-board',
  },
  {
    need: 'Testing',
    gives: 'The real container with bindings replaced, a real server on port 0',
  },
  {
    need: 'Tooling',
    gives: 'A scaffolder, and an MCP server so an agent can read your app',
  },
];

/** The one-line positioning, for a README that has no room for two lines. */
export const lead = (): string => HEADLINE.join(' ');
