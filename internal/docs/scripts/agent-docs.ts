import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GuideMeta } from './extract/model';

/**
 * The two files an agent fetches instead of reading the site.
 *
 * `setup.md` is `docs/setup.md`, copied verbatim so the URL an agent is handed
 * serves the file the repository's own guards check. `llms.txt` is the index
 * described by <https://llmstxt.org>, generated from the same guide list the nav
 * is built from, with each entry pointing at raw markdown rather than at a
 * hash-routed page a fetch cannot render.
 *
 * Both land in `public/`, which Vite copies to the output root, so they are served
 * from https://petarzarkov.github.io/dunx/ alongside the coverage badges.
 */
export const SITE_URL = 'https://petarzarkov.github.io/dunx/';

const RAW_URL = 'https://raw.githubusercontent.com/petarzarkov/dunx/main/';

/** The first paragraph under the title, flattened to one line. */
const summaryOf = (markdown: string): string => {
  const body = markdown.replace(/^#[^\n]*\n+/, '');
  const paragraph = (body.split(/\n\s*\n/)[0] ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*/g, '')
    .trim();
  if (paragraph === '' || paragraph.startsWith('```')) return '';
  const sentence = (
    /^(.+?\.)(?:\s|$)/.exec(paragraph)?.[1] ?? paragraph
  ).replace(/[:\-\s]+$/, '');
  return sentence.length > 200 ? `${sentence.slice(0, 197)}...` : sentence;
};

const entry = (title: string, url: string, summary: string): string =>
  summary === '' ? `- [${title}](${url})` : `- [${title}](${url}): ${summary}`;

interface AgentDocsOptions {
  readonly publicDir: string;
  readonly docsDir: string;
  readonly setupDoc: string;
  readonly blurb: string;
  /** The site's guides, in nav order, each with the source path it was read from. */
  readonly guides: readonly GuideMeta[];
  /** Reads a repository-relative file, returning '' when it is absent. */
  readonly read: (file: string) => string;
}

export const writeAgentDocs = (options: AgentDocsOptions): void => {
  const { publicDir, docsDir, setupDoc, blurb, guides, read } = options;

  copyFileSync(setupDoc, join(publicDir, 'setup.md'));

  // Grouped before sorting, so the tour keeps its own numbering: the reference
  // pages start at 0 too, and one flat sort put "Migrating from NestJS" above
  // "Introduction".
  const sections = (['guide', 'reference'] as const).map((category) => {
    const lines = guides
      .filter((guide) => guide.category === category)
      .sort((a, b) => a.order - b.order)
      .map((guide) => {
        const source = guide.source.replace(/^docs\//, '');
        return entry(
          guide.title,
          `${RAW_URL}docs/${source}`,
          summaryOf(read(join(docsDir, source))),
        );
      });
    const heading = category === 'guide' ? 'Guide' : 'Reference';
    return `## ${heading}\n\n${lines.join('\n')}`;
  });

  writeFileSync(
    join(publicDir, 'llms.txt'),
    `# dunx\n\n> ${blurb}\n\n` +
      'Every link under Setup, Guide and Reference is raw markdown, fetchable\n' +
      'as-is.\n\n' +
      `## Setup\n\n${entry(
        'Setting up dunx',
        `${SITE_URL}setup.md`,
        summaryOf(read(setupDoc)),
      )}\n\n${sections.join('\n\n')}\n\n` +
      '## Optional\n\n' +
      entry(
        'The documentation site',
        SITE_URL,
        'The same guides rendered, plus the API reference and the benchmarks.',
      ) +
      '\n' +
      entry(
        'The repository',
        'https://github.com/petarzarkov/dunx',
        'Source, examples and the architecture notes the site does not publish.',
      ) +
      '\n',
  );
};
