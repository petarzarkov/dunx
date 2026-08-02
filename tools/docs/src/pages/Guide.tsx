import {
  Anchor,
  Container,
  Group,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useChunk } from '../chunk';
import { Prose } from '../components/Prose';
import { guideBySlug, loadGuide, site } from '../data';
import { href, RouteKind } from '../router';
import { NotFound } from './NotFound';

const TableOfContents = ({
  slug,
  headings,
}: {
  slug: string;
  headings: readonly { id: string; text: string }[];
}): React.JSX.Element | null => {
  if (headings.length < 3) return null;

  return (
    <Stack gap={4} className="toc" component="nav">
      <Text size="xs" fw={700} tt="uppercase" c="dimmed">
        On this page
      </Text>
      {headings.map((heading) => (
        <Anchor
          key={heading.id}
          onClick={(event) => {
            // The href stays a real route so middle-click and copy-link work; the
            // scroll happens here, where the page is already laid out. Scrolling
            // from an effect on a cold load raced the code-block layout and left
            // the viewport past the end of the document, showing nothing.
            const target = document.getElementById(heading.id);
            if (!target) return;
            event.preventDefault();
            target.scrollIntoView({ block: 'start' });
          }}
          // The page's own route, not `#id`. A bare fragment in a hash-routed
          // site is read as a route, so every entry here used to navigate away
          // from the page it belonged to.
          //
          // Deliberately without `?h=`: that path runs a scroll-retry loop in
          // `router.ts` which lands on a blank viewport in headless Chrome, on
          // guides and on package pages alike. The click below scrolls a
          // laid-out page instead, which is reliable. See
          // docs/roadmap/anchor-scroll-on-cold-load.md.
          href={href(RouteKind.Guide, slug)}
          size="sm"
          c="dimmed"
          lineClamp={1}
        >
          {heading.text}
        </Anchor>
      ))}
    </Stack>
  );
};

/**
 * The title, the source link and the contents come from the index, so the page
 * is complete except for its prose on the first frame. Only the body is a
 * separate chunk - see `src/data.ts`.
 */
export const Guide = ({ slug }: { slug: string }): React.JSX.Element => {
  const guide = guideBySlug(slug);
  const body = useChunk(() => loadGuide(slug), slug);

  if (!guide) return <NotFound what={`guide "${slug}"`} />;

  return (
    <Container size="lg" py="xl">
      <Group align="flex-start" wrap="nowrap" gap="xl">
        <Stack gap="md" style={{ minWidth: 0, flex: 1 }}>
          <Title order={1}>{guide.title}</Title>
          <Anchor
            href={`${site.repoUrl}/blob/main/${guide.source}`}
            target="_blank"
            size="xs"
            c="dimmed"
          >
            {guide.source} on GitHub
          </Anchor>
          {body ? (
            <Prose html={body.html} />
          ) : (
            <Stack gap="sm" aria-busy="true">
              <Skeleton height={12} radius="sm" />
              <Skeleton height={12} radius="sm" width="92%" />
              <Skeleton height={12} radius="sm" width="70%" />
            </Stack>
          )}
        </Stack>
        <TableOfContents slug={slug} headings={guide.headings} />
      </Group>
    </Container>
  );
};
