import { Badge, Group, Text } from '@mantine/core';
import type { JSX } from 'react';
import type { ProviderNode } from '../api';

type Dependency = ProviderNode['dependencies'][number];

/**
 * What a class asks the container for, with the unresolvable ones called out.
 *
 * That distinction is the reason this is a component rather than a `join(', ')`.
 * A parameter whose type named nothing at runtime - an interface, a primitive, a
 * union, a type-only import - is a **boot error naming that parameter**, and it is
 * indistinguishable from a working one in the source. `typeOnly` is carried
 * through because that case has a one-line fix: drop the `type` from the import.
 */
export const Dependencies = ({
  dependencies,
}: {
  dependencies: readonly Dependency[];
}): JSX.Element => {
  if (dependencies.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        -
      </Text>
    );
  }

  return (
    <Group gap={4}>
      {dependencies.map((dependency, index) =>
        'unresolved' in dependency ? (
          <Badge
            key={`${dependency.unresolved}-${index}`}
            size="xs"
            variant="filled"
            color="red"
            title={
              dependency.typeOnly === undefined
                ? 'This parameter names nothing at runtime, so it is a boot error'
                : `Imported as \`import type { ${dependency.typeOnly} }\` - drop the \`type\``
            }
          >
            {dependency.unresolved}
          </Badge>
        ) : (
          <Badge
            key={`${dependency.token}-${index}`}
            size="xs"
            variant="default"
            className="dunx-mono"
          >
            {dependency.token}
          </Badge>
        ),
      )}
    </Group>
  );
};
