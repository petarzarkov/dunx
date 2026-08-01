import {
  Anchor,
  Badge,
  Button,
  Card,
  Container,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { BenchSummary } from '../components/BenchSummary';
import { Prose } from '../components/Prose';
import { site } from '../data';
import { href, RouteKind } from '../router';

export const Home = (): React.JSX.Element => (
  <Container size="lg" py="xl">
    <Stack gap="xl">
      <Stack gap="sm">
        <Badge variant="light" size="lg" w="fit-content">
          Bun-native
        </Badge>
        <Title order={1} size={48} lh={1.1}>
          dunx
        </Title>
        <Text size="xl" c="dimmed" maw={640}>
          A dependency injection framework built on Bun&apos;s own primitives.
          Constructor injection with no decorators, no{' '}
          <code>reflect-metadata</code>, and no JavaScript reimplementation of
          anything the runtime already does.
        </Text>
        <Group>
          <Button component="a" href={href(RouteKind.Bench)}>
            See the benchmarks
          </Button>
          <Button
            variant="default"
            component="a"
            href={href(RouteKind.Guide, 'architecture')}
          >
            Read the architecture
          </Button>
          <Button
            variant="default"
            component="a"
            href={site.repoUrl}
            target="_blank"
          >
            GitHub
          </Button>
        </Group>
      </Stack>

      <BenchSummary />

      <div>
        <Title order={2} size="h3" mb="sm">
          Packages
        </Title>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {site.packages.map((pkg) => (
            <Card
              key={pkg.name}
              withBorder
              radius="md"
              padding="md"
              component="a"
              href={href(RouteKind.Api, pkg.dir)}
            >
              <Stack gap="xs" h="100%">
                <Group justify="space-between" wrap="nowrap">
                  <Text fw={700} ff="monospace" size="sm">
                    {pkg.name}
                  </Text>
                  <Badge size="xs" variant="default">
                    {pkg.symbols.filter((s) => s.subpaths.length > 0).length}{' '}
                    exports
                  </Badge>
                </Group>
                <Text size="sm" c="dimmed" lineClamp={4}>
                  {pkg.description}
                </Text>
                <Group gap={4} mt="auto">
                  {pkg.subpaths.map((subpath) => (
                    <Badge key={subpath} size="xs" variant="light" color="gray">
                      {subpath}
                    </Badge>
                  ))}
                </Group>
              </Stack>
            </Card>
          ))}
        </SimpleGrid>
      </div>

      <div>
        <Title order={2} size="h3" mb="sm">
          Overview
        </Title>
        <Prose html={site.home} />
        <Text size="xs" c="dimmed" mt="lg">
          Generated from{' '}
          <Anchor href={`${site.repoUrl}/blob/main/README.md`} target="_blank">
            README.md
          </Anchor>{' '}
          on {new Date(site.generatedAt).toUTCString()}
        </Text>
      </div>
    </Stack>
  </Container>
);
