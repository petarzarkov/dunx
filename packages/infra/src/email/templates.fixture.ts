import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TemplateRenderer, type RenderedEmail } from './renderer.js';

/**
 * A directory of template modules, written to disk because that is what the
 * preview server reads. Bun executes a `.ts` module out of a temp directory the
 * same way it executes one out of a package, so there is nothing to compile.
 */
export class TemplateDir {
  private constructor(readonly path: string) {}

  static async create(): Promise<TemplateDir> {
    return new TemplateDir(await mkdtemp(join(tmpdir(), 'dunx-email-')));
  }

  async write(name: string, body: string): Promise<string> {
    const file = join(this.path, name);
    await Bun.write(file, body);
    return file;
  }

  /** A module whose default export renders to `<p>{body}</p>`. */
  template(name: string, body: string): Promise<string> {
    return this.write(
      name,
      `export default { body: ${JSON.stringify(body)} };\n`,
    );
  }

  remove(): Promise<void> {
    return rm(this.path, { recursive: true, force: true });
  }
}

/** Props arrive as `unknown`, so a non-string is dropped rather than stringified. */
const asText = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/** Renders the shape `TemplateDir.template` writes, with no React in sight. */
export class BodyRenderer extends TemplateRenderer {
  render(
    template: unknown,
    props: Record<string, unknown> = {},
  ): Promise<RenderedEmail> {
    const { body } = template as { body?: string };
    const who = asText(props['who']);
    return Promise.resolve({
      html: `<p>${body ?? ''}${who}</p>`,
      text: `${body ?? ''}${who}`,
    });
  }

  override previewProps(): Record<string, unknown> {
    return { who: '!' };
  }
}

/** Loaded by the CLI's `--renderer` in its own suite. */
export default new BodyRenderer();
