import { describe, expect, it } from 'bun:test';
import { publishedWorkspaces, sourcesOf, specifiersIn } from './published.js';

/**
 * Rule 1, as a gate rather than as prose a reader has to adjudicate.
 *
 * Bun ships an equivalent for every one of these, so a JavaScript
 * reimplementation is slower, larger and a maintenance liability. The list is
 * CLAUDE.md's, plus the tooling bans stated elsewhere in it.
 */
const BANNED: Readonly<Record<string, string>> = Object.freeze({
  express: 'Bun.serve',
  ws: 'Bun.serve({ websocket })',
  'socket.io': 'Bun.serve({ websocket })',
  ioredis: 'Bun.RedisClient',
  pg: 'Bun.SQL',
  mysql2: 'Bun.SQL',
  postgres: 'Bun.SQL',
  'better-sqlite3': 'bun:sqlite',
  sharp: 'Bun.Image',
  jimp: 'Bun.Image',
  'image-size': 'Bun.Image',
  glob: 'Bun.Glob',
  chokidar: 'fs.watch',
  axios: 'fetch',
  'node-fetch': 'fetch',
  bcrypt: 'Bun.password',
  dotenv: 'Bun loads .env itself',
  lodash: 'the standard library',
  'reflect-metadata': '@dunx/transform',
  tsyringe: '@dunx/core',
  eslint: 'oxlint',
  '@biomejs/biome': 'oxlint',
  husky: 'scripts/install-hooks.ts',
  'lint-staged': 'stagelint',
  '@changesets/cli': 'scripts/changelog.ts',
  'moment-timezone': '@arkv/timezones',
  'date-fns-tz': '@arkv/timezones',
  pino: '@arkv/logger',
  winston: '@arkv/logger',
  nanoid: '@arkv/rng',
  uuid: '@arkv/rng',
});

const isBanned = (spec: string): string | undefined => {
  if (spec.startsWith('@aws-sdk/')) return 'Bun.S3Client';
  return BANNED[spec];
};

/**
 * A `dependency` of a published workspace is installed for every consumer, so
 * the bar is first-party or native. `@arkv/*` is the repo owner's, published and
 * near weightless; `oxc-parser` is the one native module, and `@dunx/transform`
 * is build-time only.
 */
const DEPENDENCY_ALLOWED = (spec: string): boolean =>
  spec.startsWith('@arkv/') ||
  spec.startsWith('@dunx/') ||
  spec === 'oxc-parser';

/**
 * Mature libraries dunx integrates rather than competes with. They are the
 * consumer's version opinion, so they are peers and never dependencies.
 */
const MUST_BE_PEER = Object.freeze([
  'zod',
  'drizzle-orm',
  'better-auth',
  'bullmq',
  'swagger-ui-dist',
  '@scalar/api-reference',
  'rabbitmq-client',
]);

/** `@scope/name/sub` and `name/sub` both resolve to their package name. */
const packageOf = (spec: string): string => {
  const parts = spec.split('/');
  return spec.startsWith('@')
    ? parts.slice(0, 2).join('/')
    : (parts[0] ?? spec);
};

describe('Rule 1 - native implementations only', () => {
  it('no published workspace imports a package Bun already replaces', async () => {
    const offences: string[] = [];
    for (const ws of await publishedWorkspaces()) {
      for (const file of await sourcesOf(ws)) {
        const source = await Bun.file(file).text();
        for (const spec of specifiersIn(source)) {
          const use = isBanned(packageOf(spec));
          if (use === undefined) continue;
          offences.push(`${ws.name}: ${file} imports ${spec}, use ${use}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('every dependency is first-party or the one native module', async () => {
    const offences: string[] = [];
    for (const ws of await publishedWorkspaces()) {
      const deps = ws.json['dependencies'];
      if (typeof deps !== 'object' || deps === null) continue;
      for (const spec of Object.keys(deps as Record<string, unknown>)) {
        if (DEPENDENCY_ALLOWED(spec)) continue;
        offences.push(
          `${ws.name} depends on ${spec}; it belongs in peerDependencies`,
        );
      }
    }
    expect(offences).toEqual([]);
  });

  it('sanctioned integrations are peers, never dependencies', async () => {
    const offences: string[] = [];
    for (const ws of await publishedWorkspaces()) {
      const deps = ws.json['dependencies'];
      if (typeof deps !== 'object' || deps === null) continue;
      for (const spec of MUST_BE_PEER) {
        if (spec in (deps as Record<string, unknown>)) {
          offences.push(`${ws.name} must declare ${spec} as a peer`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('@dunx/core still has no dependencies at all', async () => {
    const core = (await publishedWorkspaces()).find(
      (ws) => ws.name === '@dunx/core',
    );
    expect(core).toBeDefined();
    expect(core?.json['dependencies'] ?? {}).toEqual({});
  });
});
