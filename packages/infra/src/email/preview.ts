import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Server } from 'bun';
import type { RenderedEmail, TemplateRenderer } from './renderer.js';
import {
  discoverTemplates,
  loadTemplate,
  type TemplateEntry,
} from './templates.js';
import { escapeHtml, page } from './preview-page.js';

export interface PreviewOptions {
  /** Directory holding the template modules. */
  readonly dir: string;
  readonly renderer: TemplateRenderer;
  /** `0` picks a free port, which is what the tests use. @default 3035 */
  readonly port?: number;
  readonly hostname?: string;
}

/**
 * Lists the templates in a directory and renders one, over `Bun.serve`.
 *
 * The `react-email` CLI does this by pulling `@react-email/ui` and Next.js, and
 * what it renders with is the same `render` the runtime already calls. So the
 * whole of it here is `Bun.serve`, `Bun.Glob` and `import()`: no CLI framework,
 * no bundler, no dev server, and the renderer is the one the app sends with, so
 * the preview cannot drift from what arrives in an inbox.
 */
export class EmailPreview {
  constructor(private readonly options: PreviewOptions) {}

  templates(): Promise<readonly TemplateEntry[]> {
    return discoverTemplates(this.options.dir);
  }

  /**
   * Renders one template by name with its own sample props.
   *
   * `fresh` re-executes the module, so an edit shows up on the next request
   * rather than on the next restart.
   */
  async render(name: string, fresh = false): Promise<RenderedEmail> {
    const entry = (await this.templates()).find((t) => t.name === name);
    if (entry === undefined) throw new Error(`No template named "${name}".`);
    const template = await loadTemplate(entry.path, fresh);
    const { renderer } = this.options;
    return renderer.render(template, renderer.previewProps(template));
  }

  /** Writes every template to `outDir` as `<name>.html`. @returns the files. */
  async export(outDir: string): Promise<readonly string[]> {
    const written: string[] = [];
    for (const { name } of await this.templates()) {
      const file = join(outDir, `${name}.html`);
      await mkdir(join(file, '..'), { recursive: true });
      await Bun.write(file, (await this.render(name)).html);
      written.push(file);
    }
    return written;
  }

  /**
   * Three routes, declared rather than dispatched: `Bun.serve` does the matching
   * and the method-miss 404 itself. The template name travels as a query rather
   * than a path segment, so a nested name needs no escaping.
   */
  serve(): Server<never> {
    return Bun.serve({
      port: this.options.port ?? 3035,
      ...(this.options.hostname === undefined
        ? {}
        : { hostname: this.options.hostname }),
      routes: {
        '/': async (req: Request) => {
          const names = (await this.templates()).map((t) => t.name);
          const selected = new URL(req.url).searchParams.get('tpl');
          return html(page(names, selected ?? undefined));
        },
        '/preview': (req) => this.#body(req, 'html'),
        '/text': (req) => this.#body(req, 'text'),
      },
    });
  }

  async #body(req: Request, part: 'html' | 'text'): Promise<Response> {
    const name = new URL(req.url).searchParams.get('tpl');
    if (name === null) return new Response('No ?tpl=', { status: 400 });
    try {
      const rendered = await this.render(name, true);
      if (part === 'text') {
        return new Response(rendered.text ?? '', {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      return html(rendered.html);
    } catch (error) {
      const detail = error instanceof Error ? error.stack : String(error);
      return html(failure(detail ?? 'Unknown error'), 500);
    }
  }
}

const html = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

const failure = (detail: string): string =>
  `<pre style="color:#b91c1c;padding:16px;white-space:pre-wrap">${escapeHtml(detail)}</pre>`;
