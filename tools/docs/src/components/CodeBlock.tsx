import { Paper, Text } from '@mantine/core';

/**
 * A labelled code pane. Not tokenised — there is no highlighter in the bundle,
 * and a docs site that ships one to colour four samples has its priorities the
 * wrong way round.
 */
export const CodeBlock = ({
  label,
  code,
}: {
  label: string;
  code: string;
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
    <pre className="code-pane-body">
      <code>{code}</code>
    </pre>
  </Paper>
);
