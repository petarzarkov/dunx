import { Box } from '@mantine/core';
import type { JSX } from 'react';

/**
 * Descriptions arrive as HTML already rendered by `Bun.markdown` with
 * `noHtmlBlocks`, `noHtmlSpans` and `tagFilter` on, so the raw HTML a schema
 * author wrote is escaped before it ever reaches here. Rendering it on the
 * server is also what keeps a markdown parser out of this bundle.
 */
export const Prose = ({
  html,
}: {
  html: string | undefined;
}): JSX.Element | null =>
  html === undefined || html === '' ? null : (
    <Box className="prose" fz="sm" dangerouslySetInnerHTML={{ __html: html }} />
  );
