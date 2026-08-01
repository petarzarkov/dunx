import { useCallback, type MouseEvent } from 'react';

/**
 * Markdown that Bun rendered at build time. Bare `#anchor` links inside it
 * would otherwise replace the route hash and navigate away, so they are
 * intercepted and turned into a scroll.
 */
export const Prose = ({ html }: { html: string }): React.JSX.Element => {
  const onClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest('a');
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
