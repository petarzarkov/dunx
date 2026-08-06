import { Paper, Text } from '@mantine/core';
import { Highlighted } from './Highlighted';

/**
 * A labelled code pane. The highlighting happened at generate time, so there is
 * still no highlighter in the bundle - see `Highlighted`.
 */
export const CodeBlock = ({
  label,
  code,
  id,
}: {
  label: string;
  code: string;
  /** Key into the generate-time highlighted map. */
  id: string;
}): React.JSX.Element => (
  <Paper withBorder radius="md" className="code-pane">
    <Text
      component="div"
      size="xs"
      c="dimmed"
      ff="monospace"
      className="code-pane-label"
    >
      {label}
    </Text>
    <Highlighted id={id} fallback={code} />
  </Paper>
);
