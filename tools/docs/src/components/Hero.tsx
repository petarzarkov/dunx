import {
  Badge,
  Box,
  Button,
  CopyButton,
  Container,
  Grid,
  Group,
  Stack,
  Text,
} from '@mantine/core';
import { decimal, scenarioHeadlines, startupHeadline } from '../bench';
import { bench, site } from '../data';
import { href, RouteKind } from '../router';
import { EditorWindow, type EditorFile } from './EditorWindow';

const FILES: readonly EditorFile[] = [
  {
    name: 'users.service.ts',
    code: `export class UsersRepository {
  constructor(private readonly db: DbConnection) {}
}

export class UsersService {
  constructor(private readonly repo: UsersRepository) {}

  findAll() {
    return this.repo.all();
  }
}`,
  },
  {
    name: 'users.controller.ts',
    code: `@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('/')
  list() {
    return this.users.findAll();
  }
}`,
  },
  {
    name: 'main.ts',
    code: `import { HttpFactory } from '@dunx/http';

const app = await HttpFactory.create(AppModule);

await app.listen(3000);`,
  },
  {
    name: 'bunfig.toml',
    code: `preload = ["@dunx/transform/preload"]`,
  },
];

const INSTALL = 'bun add @dunx/core @dunx/http @dunx/transform';

const InstallLine = (): React.JSX.Element => (
  <div className="install">
    <span className="install-prompt" aria-hidden="true">
      $
    </span>
    {/* Scrolls on its own rather than wrapping: a wrapped command pushed the
        copy button out of the box on a phone. */}
    <span className="install-cmd">{INSTALL}</span>
    <CopyButton value={INSTALL}>
      {({ copied, copy }) => (
        <Button
          size="compact-xs"
          variant={copied ? 'light' : 'default'}
          onClick={copy}
          aria-label="Copy the install command"
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      )}
    </CopyButton>
  </div>
);

/**
 * The one line under the fold that is a measurement rather than a claim. It
 * renders only when a benchmark run is in the model, because a hero that states
 * a number the site cannot show the working for is the thing this repo spends
 * most of its effort not doing.
 */
const MeasuredLine = (): React.JSX.Element | null => {
  if (!bench) return null;
  const plaintext = scenarioHeadlines(bench)[0];
  const startup = startupHeadline(bench);
  if (!plaintext) return null;

  return (
    <Text size="sm" c="dimmed">
      <b>{decimal(plaintext.focusPct, 1)}%</b> of raw <code>Bun.serve</code> on{' '}
      {plaintext.title.toLowerCase()}
      {startup && (
        <>
          , cold start <b>{decimal(startup.focusMs, 1)} ms</b>
        </>
      )}{' '}
      — measured on this machine, published with the standard deviation and the
      losses.
    </Text>
  );
};

export const Hero = (): React.JSX.Element => (
  <Box component="section" className="hero">
    <div className="hero-glow" aria-hidden="true" />
    <Container size="lg">
      <Grid gutter={{ base: 'xl', md: 48 }} align="center">
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Stack gap="lg">
            <Group gap={6}>
              <Badge variant="light" size="sm" tt="none" radius="sm">
                Bun-native
              </Badge>
              <Badge variant="default" size="sm" tt="none" radius="sm">
                zero-dependency core
              </Badge>
              <Badge variant="default" size="sm" tt="none" radius="sm">
                no reflect-metadata
              </Badge>
            </Group>

            <Stack gap="sm">
              <h1 className="hero-title">
                Nest-shaped ergonomics.
                <br />
                <span className="gradient-text">None of the runtime.</span>
              </h1>
              <Text size="lg" c="dimmed" maw={540}>
                A dependency injection framework built on Bun&apos;s own
                primitives. Constructor injection with nothing annotating it —
                no <code>@Injectable()</code>, no <code>@Inject()</code>, no{' '}
                <code>reflect-metadata</code>.
              </Text>
            </Stack>

            <InstallLine />

            <Group gap="sm">
              <Button
                component="a"
                href={href(RouteKind.Guide, 'architecture')}
                size="md"
              >
                Get started
              </Button>
              <Button
                component="a"
                href={href(RouteKind.Bench)}
                size="md"
                variant="default"
              >
                See the benchmarks
              </Button>
              <Button
                component="a"
                href={site.repoUrl}
                target="_blank"
                size="md"
                variant="subtle"
              >
                GitHub
              </Button>
            </Group>

            <MeasuredLine />
          </Stack>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 6 }}>
          <EditorWindow files={FILES} label="A dunx application" />
        </Grid.Col>
      </Grid>
    </Container>
  </Box>
);
