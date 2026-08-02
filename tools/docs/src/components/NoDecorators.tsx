import { Anchor, Card, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { href, RouteKind } from '../router';
import { CodeBlock } from './CodeBlock';

const PRELOAD = `preload = ["@dunx/compiler/preload"]`;

const NEST = `@Injectable()
export class UsersService {
  constructor(
    @Inject(UsersRepository)
    private readonly repo: UsersRepository,
  ) {}
}`;

const DUNX = `export class UsersService {
  constructor(private readonly repo: UsersRepository) {}
}`;

/**
 * The hero already shows what dunx code looks like, so this section does the
 * thing the hero cannot: put it beside the framework it is being compared with,
 * and say what makes the difference possible.
 */
export const NoDecorators = (): React.JSX.Element => (
  <Stack gap="xl">
    <Stack gap={6}>
      <Title order={2} size="h2">
        Constructor injection, with nothing annotating it
      </Title>
      <Text c="dimmed" maw={640}>
        No <code>@Injectable()</code>. No <code>@Inject()</code> — TC39 standard
        decorators have no parameter decorators, so it does not exist and never
        will. No <code>reflect-metadata</code>, no{' '}
        <code>experimentalDecorators</code>, no <code>tsyringe</code>.
      </Text>
    </Stack>

    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
      <CodeBlock label="NestJS" code={NEST} />
      <CodeBlock label="dunx" code={DUNX} />
    </SimpleGrid>

    <Card withBorder radius="md" padding="lg">
      <Stack gap="sm">
        <Text fw={700}>What turns it on — one line, once, per app</Text>
        <CodeBlock label="bunfig.toml" code={PRELOAD} />
        <Text size="sm" c="dimmed">
          <Anchor href={href(RouteKind.Api, 'compiler')}>
            <code>@dunx/compiler</code>
          </Anchor>{' '}
          reads each class&apos;s constructor parameter types at load time and
          records them on the class as a thunk; the container resolves them
          before calling <code>new</code>. A thunk rather than a value, which is
          what makes a dependency declared later in the file — or across a
          circular import — work with no <code>forwardRef</code>.
        </Text>
        <Text size="sm" c="dimmed">
          A parameter whose type erased — an interface, a primitive, a union, a
          type-only import — is a <b>boot error naming that parameter</b>, not a
          silent <code>undefined</code>. That is the wart{' '}
          <code>emitDecoratorMetadata</code> has and this does not.
        </Text>
      </Stack>
    </Card>
  </Stack>
);
