import { Anchor, Container, Group, Stack, Text, Title } from '@mantine/core';
import { Prose } from '../components/Prose';
import { guideBySlug, site } from '../data';
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

export const Guide = ({ slug }: { slug: string }): React.JSX.Element => {
  const guide = guideBySlug(slug);
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
          <Prose html={guide.html} />
        </Stack>
        <TableOfContents headings={guide.headings} />
      </Group>
    </Container>
  );
};
