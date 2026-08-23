import { modulesOf, providersOf, type ModuleRef } from '@dunx/core';
import { gatewaysOf, isGateway, routesOf } from '@dunx/http/internal';
import type { DashboardOptions } from '../options.js';
import type { ConfigEntry, Meta, Snapshot } from './types.js';

/**
 * The static half of the page, built from the same readers `@dunx/mcp` answers
 * with. Nothing here constructs anything: `providersOf` and `routesOf` walk
 * prototypes, so this would answer identically before the app booted.
 *
 * That is the deliberate inversion of MCP's rule. MCP refuses runtime questions
 * because booting an app to answer them would open databases and bind sockets;
 * this package is *already inside* a booted app, so the reason does not apply and
 * the live panels ask the container directly. Splitting it per panel rather than
 * per package is what stops this file growing a `boot()`.
 */

const typeOf = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

/**
 * Keys, types, and a value only where the app's `reveal` predicate said so.
 *
 * Sorted, because a config panel is read by scanning for a key rather than in
 * declaration order, and `validate` returns whatever object literal order the app
 * happened to write.
 */
export const configEntries = (
  values: object,
  reveal: DashboardOptions['reveal'],
): readonly ConfigEntry[] =>
  Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]: [string, unknown]) => ({
      key,
      type: typeOf(value),
      ...(reveal(key, value) ? { value } : {}),
    }));

export const metaOf = (options: DashboardOptions): Meta => ({
  title: options.title,
  basePath: options.path,
  openApiPath: options.openApiPath,
  pollMs: options.pollMs,
  queuesPath: `${options.path}/queues`,
});

export const snapshotOf = (
  root: ModuleRef,
  options: DashboardOptions,
): Snapshot => ({
  meta: metaOf(options),
  routes: routesOf(root),
  gateways: gatewaysOf(root),
  // Core cannot import `@dunx/http`, so the gateway marker arrives as an option.
  // Without it a gateway would be listed as an ordinary provider here while the
  // gateways panel showed it as one, and the two panels would disagree.
  modules: modulesOf(root, { isGateway }),
  providers: providersOf(root, { isGateway }),
  // Absent when the app passed no `config`, which the panel reports as such - a
  // different fact from a configuration with no keys in it.
  config:
    options.config === undefined
      ? undefined
      : configEntries(options.config.values, options.reveal),
});
