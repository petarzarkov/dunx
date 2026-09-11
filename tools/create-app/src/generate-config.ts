import { BASE_CONFIG, CONFIG_GROUPS, type Feature } from './features.js';
import { HEADER, uniq } from './header.js';

/** Every config group the selection needs, base first, in a stable order. */
export const configGroupsFor = (
  features: readonly Feature[],
): readonly string[] => {
  const wanted = uniq([
    ...BASE_CONFIG,
    ...features.flatMap((feature) => feature.config),
  ]);
  return Object.keys(CONFIG_GROUPS).filter((group) => wanted.includes(group));
};

export const config = (name: string, groups: readonly string[]): string => {
  const chosen = groups
    .map((group) => [group, CONFIG_GROUPS[group]] as const)
    .filter(
      (entry): entry is [string, (typeof CONFIG_GROUPS)[string]] =>
        entry[1] !== undefined,
    );

  const schema = chosen.flatMap(([, group]) => group.schema);
  const needsLogLevel = groups.includes('log');

  return `${HEADER(name)}import {
  ConfigModule,
  ConfigService,
  type ConfigSource,
  type DynamicModule,${needsLogLevel ? '\n  LogLevel,' : ''}
} from '@dunx/core';
import { z } from 'zod';

/**
 * One validation function, which is the whole \`ConfigModule\` contract. dunx does
 * not pick the library - this is zod because the routes already use it, and a
 * hand-written function that throws would work identically.
 *
 * \`.default()\` is where a value comes from when the variable is unset, so a clean
 * checkout boots with no \`.env\` at all. Bun loads \`.env\` and \`.env.local\` itself,
 * so there is nothing here that reads a file.
 */
const envSchema = z.object({
${schema.map((line) => `  ${line}`).join('\n')}
});

export interface AppConfig {
${chosen.map(([, group]) => `  ${group.field}`).join('\n')}
}

/**
 * One name for the typed config everywhere. A subclass rather than
 * \`ConfigService<AppConfig>\` at each site because a factory's \`inject: [...]\`
 * carries no type argument - the class does, and it is a real runtime value, so it
 * is both a precise token and a usable constructor annotation.
 */
export class AppConfigService extends ConfigService<AppConfig> {}

/** The one broker channel the websocket relay carries every topic on. */
export const RELAY_CHANNEL = '__DUNX_APP_NAME__:ws';

/** Flat variables in, a shaped object out. Nothing downstream reads \`Bun.env\`. */
export const validate = (env: ConfigSource): AppConfig => {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => \`\${issue.path.join('.') || '(root)'}: \${issue.message}\`)
      .join('\\n - ');
    throw new Error(\`Configuration is invalid:\\n - \${issues}\`);
  }
  const value = parsed.data;

  return {
${chosen.map(([, group]) => `    ${group.map}`).join('\n')}
  };
};

/**
 * One place: every entry point and test slice builds config the same way, so a
 * new option reaches all of them. \`source\` is all a caller varies.
 */
export const configModule = (source?: ConfigSource): DynamicModule =>
  ConfigModule.forRoot({
    validate,
    as: AppConfigService,
    ...(source === undefined ? {} : { source }),
  });
`;
};
