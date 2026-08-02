import { Container, Grid, Paper, Stack, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { SAMPLES } from '../samples';
import { Highlighted } from './Highlighted';

/**
 * The long tour. A vertical tablist rather than one sample after another: nine
 * stacked code blocks is a wall nobody reads, and the point is that each of
 * these is short.
 */
export const ShowMeTheCode = (): React.JSX.Element => {
  const [active, setActive] = useState(0);
  const shown = SAMPLES[active] ?? SAMPLES[0];
  if (!shown) return <></>;

  return (
    <Container size="lg" component="section">
      <Stack gap="xl">
        <Stack gap={6}>
          <Title order={2} size="h2">
            Show me the code
          </Title>
          <Text c="dimmed" maw={640}>
            Every sample here is lifted from the example app rather than written
            for this page. If it is on this page, it runs in CI.
          </Text>
        </Stack>

        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, sm: 3 }}>
            <div
              className="sample-tabs"
              role="tablist"
              aria-orientation="vertical"
              aria-label="Code samples"
            >
              {SAMPLES.map((sample, index) => (
                <button
                  key={sample.id}
                  type="button"
                  role="tab"
                  id={`sample-tab-${sample.id}`}
                  aria-selected={index === active}
                  aria-controls="sample-panel"
                  data-active={index === active}
                  className="sample-tab"
                  onClick={() => setActive(index)}
                >
                  {sample.label}
                </button>
              ))}
            </div>
          </Grid.Col>

          <Grid.Col span={{ base: 12, sm: 9 }}>
            <Stack
              gap="sm"
              id="sample-panel"
              role="tabpanel"
              aria-labelledby={`sample-tab-${shown.id}`}
            >
              <Paper withBorder radius="md" className="win">
                <div className="win-bar">
                  <div className="win-dots" aria-hidden="true">
                    <span className="win-dot" />
                    <span className="win-dot" />
                    <span className="win-dot" />
                  </div>
                  <Text size="xs" c="dimmed" ff="monospace">
                    {shown.file}
                  </Text>
                </div>
                <Highlighted id={shown.id} fallback={shown.code} />
              </Paper>
              <Text size="sm" c="dimmed">
                {shown.blurb}
              </Text>
            </Stack>
          </Grid.Col>
        </Grid>
      </Stack>
    </Container>
  );
};
