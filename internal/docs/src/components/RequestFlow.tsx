import { Badge, Container, Group, Stack, Text, Title } from '@mantine/core';
import { useReveal } from '../reveal';

interface Layer {
  readonly who: string;
  readonly what: string;
  /** A node, not a string: several of these need inline code and Markdown is
      not parsed here, so backticks would render as backticks. */
  readonly detail: React.ReactNode;
  /** Sees the response on the way back out, not just the request on the way in. */
  readonly wraps?: string;
  readonly native?: boolean;
}

const LAYERS: readonly Layer[] = [
  {
    who: 'Bun.serve',
    what: 'matches the route',
    native: true,
    wraps: 'writes the socket',
    detail:
      'Path params and per-method dispatch happen in Zig. dunx registers routes with Bun and never walks a JavaScript router, so a method miss is Bun’s 404 rather than ours.',
  },
  {
    who: 'RequestLoggingMiddleware',
    what: 'opens a context scope',
    wraps: 'writes one line, request and response together',
    detail:
      'Outermost in the chain and on by default. It starts an AsyncLocalStorage scope carrying the request metadata, so anything logged deeper in the call stack is correlated without being handed a request object. 4xx logs at warn, 5xx at error.',
  },
  {
    who: 'Global middleware',
    what: 'runs, outermost first',
    wraps: 'can rewrite the response',
    detail:
      'CORS and anything the app added. This nesting is the whole point: middleware wraps next(), which is why one middleware sees both halves and dunx needs no separate interceptor for the second.',
  },
  {
    who: 'Guards',
    what: 'accept, or throw',
    detail: (
      <>
        A guard is middleware that throws. <code>return next()</code> allows it
        through, <code>throw new HttpError(HttpStatusCode.FORBIDDEN)</code>{' '}
        refuses: there is no CanActivate and no boolean to return. Providers
        resolve eagerly at boot, so a guard prevents the handler being called,
        not constructed.
      </>
    ),
  },
  {
    who: 'Standard Schema',
    what: 'validates params, query, body',
    detail:
      'Whatever validator the route’s schema came from: zod, Valibot, ArkType. Coercion happens here, so :id is already a number when the handler reads it. A failure is a 400 that never reaches your code.',
  },
];

const HANDLER = {
  who: 'Your handler',
  detail:
    'Constructor-injected dependencies were resolved at boot, not per request. The parameter type is inferred from the same schema that validated it, so nothing is declared twice. Return an object and it becomes JSON, a string stays text, 201 is the POST default. When the handler is synchronous and reads no body, the whole path stays synchronous and no promise is allocated.',
} as const;

/**
 * The nesting is the argument. Every one of these was documented on its own
 * page and nothing showed them in sequence, which left "middleware wraps
 * next()" as a claim in prose rather than a shape you can see.
 */
export const RequestFlow = (): React.JSX.Element => {
  const { ref, revealed } = useReveal<HTMLDivElement>();

  return (
    <Container size="lg" component="section">
      <Stack gap="xl">
        <Stack gap={6}>
          <Title order={2} size="h2">
            What happens to a request
          </Title>
          <Text c="dimmed" maw={660}>
            Each layer wraps the one inside it. The ones that call{' '}
            <code>next()</code> see the response coming back out, which is why a
            single middleware can log both halves. Two of these layers are the
            runtime rather than the framework, which is the point.
          </Text>
        </Stack>

        <div className="onion" ref={ref} data-revealed={revealed}>
          {LAYERS.reduceRight(
            (inner, layer, index) => (
              <div
                className="onion-layer"
                key={layer.who}
                data-native={layer.native === true}
                style={{ '--depth': index } as React.CSSProperties}
              >
                <div className="onion-head">
                  <span className="onion-arrow" aria-hidden="true">
                    ↓
                  </span>
                  <Text ff="monospace" fw={700} size="sm">
                    {layer.who}
                  </Text>
                  <Text size="sm" c="dimmed">
                    {layer.what}
                  </Text>
                  {layer.native === true && (
                    <Badge size="xs" variant="light" color="cyan" tt="none">
                      native
                    </Badge>
                  )}
                </div>

                <Text size="xs" c="dimmed" className="onion-detail">
                  {layer.detail}
                </Text>

                {inner}

                {layer.wraps !== undefined && (
                  <div className="onion-return">
                    <span className="onion-arrow" aria-hidden="true">
                      ↑
                    </span>
                    <Text size="xs" c="dimmed">
                      {layer.wraps}
                    </Text>
                  </div>
                )}
              </div>
            ),
            <div className="onion-core">
              <Group gap="xs" wrap="wrap">
                <Text ff="monospace" fw={700} size="sm">
                  {HANDLER.who}
                </Text>
                <Badge size="xs" variant="light" color="indigo" tt="none">
                  typed input
                </Badge>
              </Group>
              <Text size="xs" c="dimmed">
                {HANDLER.detail}
              </Text>
            </div>,
          )}
        </div>

        <Text size="xs" c="dimmed" maw={660}>
          An unmatched path is logged too. <code>Bun.serve</code> answers a miss
          itself, so <code>listen()</code> installs one fetch fallback that puts
          the global middleware in front of a 404. Bun still does all the
          matching, and the fallback runs only once it has matched nothing.
        </Text>
      </Stack>
    </Container>
  );
};
