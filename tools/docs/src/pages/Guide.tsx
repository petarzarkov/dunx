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
import { NotFound } from './NotFound';

const TableOfContents = ({
  headings,
}: {
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
          href={`#${heading.id}`}
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
        <TableOfContents headings={guide.headings} />
      </Group>
    </Container>
  );
};
