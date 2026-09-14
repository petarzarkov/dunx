import type { ConfigFile } from './src/config.js';

/** Imported, not parsed, so it composes a value and `satisfies` checks it. */
const appName = 'dunx-full';

export default {
  appName,
  EMAIL_FROM: `${appName} <no-reply@dunx.win>`,
} satisfies ConfigFile;
