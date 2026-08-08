import { Box, type MantineSize } from '@mantine/core';
import { useCallback, type JSX, type MouseEvent } from 'react';

/**
 * Markdown someone else already rendered to HTML.
 *
 * Every dunx page renders markdown on the **server** - `internal/docs` at generate
 * time with Bun, `@dunx/openapi` per document with `Bun.markdown.html` and HTML
 * off. That is what keeps a markdown parser out of every bundle, and it is why
 * this takes a string rather than doing any parsing.
 *
 * Two behaviours are delegated here rather than baked into that HTML, because it
 * is a static string with no scripts in it:
 *
 * - **In-page anchors.** A bare `#anchor` would replace the route hash and
 *   navigate away in a hash-routed site, so it becomes a scroll instead.
 * - **Copy buttons.** One listener on the container rather than one per block,
 *   and no `onclick` attribute for a CSP to have to allow.
 *
 * Both are inert on HTML that contains neither, which is why one component serves
 * the documentation site and the API explorer instead of the two near-copies that
 * used to exist. The styling is `.prose` in `@dunx/ui/styles.css`, likewise once.
 */
export const Prose = ({
  html,
  size,
}: {
  html: string | undefined;
  /** Descriptions inside a card read at `sm`; a documentation page at its own. */
  size?: MantineSize;
}): JSX.Element | null => {
  const onClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;

    const copy = target.closest('.code-copy');
    if (copy) {
      // The `<pre>` is the figure's other child, so this is a sibling lookup
      // rather than anything positional.
      const code = copy
        .closest('.code-block')
        ?.querySelector('pre')?.textContent;
      if (code === null || code === undefined) return;

      void navigator.clipboard?.writeText(code).then(() => {
        const before = copy.textContent;
        copy.textContent = 'Copied';
        window.setTimeout(() => {
          copy.textContent = before;
        }, 1200);
      });
      return;
    }

    const anchor = target.closest('a');
    const href = anchor?.getAttribute('href');
    if (!href?.startsWith('#') || href.startsWith('#/')) return;

    event.preventDefault();
    document
      .getElementById(href.slice(1))
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);

  if (html === undefined || html === '') return null;

  return (
    <Box
      className="prose"
      {...(size === undefined ? {} : { fz: size })}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
