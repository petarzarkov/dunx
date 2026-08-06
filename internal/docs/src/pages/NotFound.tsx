import { Button, Container, Stack, Text, Title } from '@mantine/core';
import { href, RouteKind } from '../router';

export const NotFound = ({ what }: { what: string }): React.JSX.Element => (
  <Container size="sm" py="xl">
    <Stack gap="md" align="flex-start">
      <Title order={1}>Not found</Title>
      <Text c="dimmed">There is no {what} in this documentation build.</Text>
      <Button component="a" href={href(RouteKind.Home)} variant="default">
        Back to the start
      </Button>
    </Stack>
  </Container>
);
