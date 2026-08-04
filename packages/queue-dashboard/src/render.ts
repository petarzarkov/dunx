import { AppError } from '@dunx/core';
import type { Renderer } from './adapter.js';

/**
 * Renders bull-board's entry template with `ejs`.
 *
 * `ejs` is bull-board's own choice of template engine - `index.ejs` in
 * `@bull-board/ui` is an ejs file and its shape is theirs to change - so this
 * satisfies it rather than substituting for it. Today that template is 27 lines
 * with five interpolations and no control flow, which is tempting to handle with a
 * string replace; the moment bull-board adds a conditional, a hand-rolled
 * substitution renders a broken page instead of failing, and dunx would be
 * maintaining a template engine it never meant to write.
 *
 * Loaded with `await import()` so it is only required when a dashboard is actually
 * mounted: it is an optional peer, like `@bull-board/api` and `@bull-board/ui`, and
 * an app that never calls `QueueDashboardModule.forRoot` installs none of them.
 */
export class DashboardUnavailableError extends AppError {
  override readonly name = 'DashboardUnavailableError';
}

const missing = (packages: readonly string[], cause: unknown): AppError =>
  new DashboardUnavailableError(
    `@dunx/queue-dashboard needs ${packages.join(', ')}, which this app does not ` +
      `have. Install them with \`bun add ${packages.join(' ')}\`. (${String(cause)})`,
  );

interface Ejs {
  readonly renderFile: (
    path: string,
    data: Record<string, unknown>,
  ) => Promise<string>;
}

export const ejsRenderer = async (): Promise<Renderer> => {
  let ejs: Ejs;
  try {
    ejs = (await import('ejs')) as unknown as Ejs;
  } catch (error) {
    throw missing(['ejs'], error);
  }

  return (viewPath, params) => ejs.renderFile(viewPath, params);
};

/**
 * `@bull-board/api` and the directory `@bull-board/ui` ships its assets in.
 *
 * The UI path is resolved with `Bun.resolveSync` from this file rather than
 * hard-coded, so it is found wherever the package manager put it - hoisted to the
 * root or nested under this package.
 */
export interface BullBoardModules {
  readonly createBullBoard: (config: {
    queues: readonly unknown[];
    serverAdapter: unknown;
    options?: unknown;
  }) => unknown;
  readonly BullMQAdapter: new (queue: unknown) => unknown;
  readonly uiPath: string;
}

export const loadBullBoard = async (): Promise<BullBoardModules> => {
  try {
    const [api, bullmq] = await Promise.all([
      import('@bull-board/api'),
      import('@bull-board/api/bullMQAdapter'),
    ]);
    // `@bull-board/ui` has no main entry worth importing - it is a directory of
    // assets - so its location comes from resolving its manifest.
    const manifest = Bun.resolveSync(
      '@bull-board/ui/package.json',
      import.meta.dir,
    );
    return {
      createBullBoard: (api as unknown as BullBoardModules).createBullBoard,
      BullMQAdapter: (
        bullmq as unknown as { BullMQAdapter: new (q: unknown) => unknown }
      ).BullMQAdapter,
      uiPath: `${manifest.slice(0, manifest.lastIndexOf('/'))}/dist`,
    };
  } catch (error) {
    throw missing(['@bull-board/api', '@bull-board/ui'], error);
  }
};
