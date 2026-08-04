import { AppError } from '@dunx/core';
import type { Renderer } from './adapter.js';

export class DashboardUnavailableError extends AppError {
  override readonly name = 'DashboardUnavailableError';
}

/**
 * Raised when bull-board's entry template uses more of ejs than substitution covers.
 * Loud on purpose: the alternative is serving a page with a stray `<% if %>` in it.
 */
export class TemplateSyntaxError extends AppError {
  override readonly name = 'TemplateSyntaxError';
}

const missing = (packages: readonly string[], cause: unknown): AppError =>
  new DashboardUnavailableError(
    `@dunx/queue-dashboard needs ${packages.join(', ')}, which this app does not ` +
      `have. Install them with \`bun add ${packages.join(' ')}\`. (${String(cause)})`,
  );

/** `<%= name %>` escapes, `<%- name %>` does not. Nothing else is supported. */
const TAG = /<%(=|-)\s*([A-Za-z_$][\w$]*)\s*%>/g;

/**
 * Renders bull-board's entry template by substituting its interpolations. **The
 * default, and it needs no dependency.**
 *
 * bull-board's `index.ejs` is 27 lines with five interpolations - `basePath`,
 * `title`, `favIconDefault`, `favIconAlternative` and `uiConfig` - and **no control
 * flow**: no conditionals, no loops, no includes. Measured, not assumed. Pulling in
 * `ejs` at 210 KB to substitute five strings is a lot of dependency for one
 * `String.replace`, so it is not a dependency at all.
 *
 * `<%=` escapes with `Bun.escapeHTML` - exactly the characters ejs escapes
 * (`& < > " '`), and native. `<%-` is raw, which is what `uiConfig` needs: it is JSON
 * going into a `<script type="application/json">`. `render.test.ts` renders the real
 * template both ways and asserts they agree.
 *
 * **This assumes bull-board's template stays interpolation-only.** An interpolation
 * whose name the entry handler does not supply still throws, so a *renamed* parameter
 * is caught - but control flow added in a future bull-board release would be emitted
 * into the page verbatim rather than rejected. If a dashboard ever renders with a
 * stray `<%` in it, that is what happened, and {@link ejsRenderer} is the fix.
 */
export const substituteRenderer: Renderer = async (viewPath, params) => {
  const template = await Bun.file(viewPath).text();

  const rendered = template.replace(
    TAG,
    (_match, kind: string, name: string) => {
      if (!(name in params)) {
        throw new TemplateSyntaxError(
          `bull-board's ${viewPath} interpolates "${name}", which its entry ` +
            'handler did not supply. Install ejs and pass ejsRenderer, or upgrade ' +
            '@dunx/queue-dashboard.',
        );
      }
      const value = params[name];
      const text = value === null || value === undefined ? '' : String(value);
      return kind === '=' ? Bun.escapeHTML(text) : text;
    },
  );

  return rendered;
};

interface Ejs {
  readonly renderFile: (
    path: string,
    data: Record<string, unknown>,
  ) => Promise<string>;
}

/**
 * The full engine, for the day bull-board's template needs it.
 *
 * Not the default and not a required dependency: pass it as
 * `QueueDashboardModule.forRoot({ render: await ejsRenderer() })` if
 * {@link substituteRenderer} ever throws. `ejs` stays an **optional** peer, so an app
 * that does not need it installs nothing.
 */
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
