import { Badge, Container, Group, Stack, Text, Title } from '@mantine/core';

interface Step {
  readonly who: string;
  readonly what: string;
  readonly detail: string;
  readonly native?: boolean;
}

const STEPS: readonly Step[] = [
  {
    who: 'Bun.serve',
    what: 'matches the route',
    native: true,
    detail:
      'Path params and per-method dispatch happen in Zig. dunx registers routes with Bun and never walks a JavaScript router — a method miss is Bun’s 404, not ours.',
  },
  {
    who: 'RequestLoggingMiddleware',
    what: 'opens a context scope',
    detail:
      'Outermost in the chain and on by default. It starts an AsyncLocalStorage scope carrying the request metadata, so anything logged deeper in the call stack is correlated without being passed a request object.',
  },
  {
    who: 'Global middleware',
    what: 'runs, outermost first',
    detail:
      'CORS and anything the app added. Middleware wraps next(), which is why one middleware can log the request and the response together instead of needing an interceptor for the second half.',
  },
  {
    who: 'Guards',
    what: 'accept or reject',
    detail:
      'A guard returning false becomes a 403 before the handler is constructed. SessionGuard in @dunx/auth is the better-auth-backed one.',
  },
  {
    who: 'Standard Schema',
    what: 'validates params, query, body',
    detail:
      'Whatever validator the route’s schema came from — zod, Valibot, ArkType. Coercion happens here, so :id is already a number when the handler reads it. A failure is a 400 that never reaches your code.',
  },
  {
    who: 'Your handler',
    what: 'receives typed input',
    detail:
      'Constructor-injected dependencies were resolved at boot, not per request. The parameter type is inferred from the same schema that validated it, so nothing is declared twice.',
  },
  {
    who: '@dunx/http',
    what: 'turns the return value into a Response',
    detail:
      'An object becomes JSON, a string stays text, 201 is the POST default. A thrown HttpError is mapped to its status; anything else is a 500 that gets logged with its stack. When the handler is synchronous and reads no body, this whole path stays synchronous — no promise is allocated.',
  },
  {
    who: 'RequestLoggingMiddleware',
    what: 'writes one line',
    detail:
      'Request and response in a single entry, 4xx at warn and 5xx at error. Unmatched paths are logged too, through a single fetch fallback that runs only once Bun has matched nothing.',
  },
];

/**
 * What actually happens to a request, in order. This is the section the docs
 * were missing: the pieces are each documented on their own page and nowhere
 * showed them in sequence.
 */
export const RequestFlow = (): React.JSX.Element => (
  <Container size="lg" component="section">
    <Stack gap="xl">
      <Stack gap={6}>
        <Title order={2} size="h2">
          What happens to a request
        </Title>
        <Text c="dimmed" maw={640}>
          In order, from the socket to the log line. Two of these steps are the
          runtime rather than the framework, which is the point.
        </Text>
      </Stack>

      <div className="flow">
        {STEPS.map((step, index) => (
          <div className="flow-step" key={step.who + step.what}>
            <div className="flow-rail" aria-hidden="true">
              <span className="flow-dot" data-native={step.native === true} />
            </div>
            <Stack gap={4} pb="lg">
              <Group gap="xs" wrap="wrap">
                <Text ff="monospace" fw={700} size="sm">
                  {step.who}
                </Text>
                <Text size="sm" c="dimmed">
                  {step.what}
                </Text>
                {step.native === true && (
                  <Badge size="xs" variant="light" color="cyan" tt="none">
                    native
                  </Badge>
                )}
              </Group>
              <Text size="sm" c="dimmed" maw={720}>
                {step.detail}
              </Text>
            </Stack>
            <span className="flow-index" aria-hidden="true">
              {String(index + 1).padStart(2, '0')}
            </span>
          </div>
        ))}
      </div>
    </Stack>
  </Container>
);
