import { useCallback, type MouseEvent } from 'react';

/**
 * Markdown that Bun rendered at build time.
 *
 * Two things are delegated from here rather than baked into the generated HTML,
 * because that HTML is a static string with no scripts in it:
 *
 * - **In-page anchors.** A bare `#anchor` would replace the route hash and
 *   navigate away in a hash-routed site, so it becomes a scroll.
 * - **Copy buttons.** One listener on the container rather than one per block,
 *   and no `onclick` attribute for a CSP to have to allow.
 */
export const Prose = ({ html }: { html: string }): React.JSX.Element => {
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

  return (
    <div
      className="prose"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
