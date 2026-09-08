/**
 * The first paragraph under a markdown title, flattened to one line.
 *
 * It lives here rather than in `internal/docs` because two things now want it:
 * the documentation site records it on each page and writes it into `llms.txt`,
 * and `gen-mcp-corpus.ts` puts it in `dunx_guide`'s index and in each MCP
 * resource's description. A second extractor gave the same chapter one summary on
 * the site and a different one over the protocol, and the weaker of the two
 * shipped `[link](url)` and `**bold**` verbatim to a model.
 *
 * `internal/docs/scripts/agent-docs.ts` re-exports it, so its own callers are
 * unchanged.
 */
export const summaryOf = (markdown: string): string => {
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
