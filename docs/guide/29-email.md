# Email

`@dunx/infra/email` is one `EmailTransport` contract, the four things every app
otherwise rewrites around it, and a preview server over `Bun.serve`. The
provider stays an optional peer on a subpath of its own, the way `drizzle-orm`
and `bullmq` do.

## The module

```ts
import { Module } from '@dunx/core';
import { EmailModule } from '@dunx/infra/email';
import { ResendTransport } from '@dunx/infra/email/resend';
import { ReactEmailRenderer } from '@dunx/infra/email/react';

@Module({
  imports: [
    EmailModule.forRootAsync({
      useFactory: (config: AppConfigService) => ({
        transport: new ResendTransport({ apiKey: config.get('email').apiKey }),
        renderer: new ReactEmailRenderer(),
        from: 'Ops <ops@example.com>',
        maxPerSecond: 2,
        dryRun: !config.get('isProd'),
      }),
      inject: [AppConfigService],
    }),
  ],
})
export class MailModule {}
```

That binds four tokens: `EmailOptions`, `EmailTransport`, `TemplateRenderer` and
`EmailService`. Inject the last one.

```ts
import { EmailService } from '@dunx/infra/email';

export class Notices {
  constructor(private readonly email: EmailService) {}

  welcome(to: string, name: string) {
    return this.email.send({
      to,
      subject: `Welcome, ${name}`,
      html: '<p>Hi</p>',
    });
  }
}
```

`EmailModule.forRoot()` with no arguments boots too. The transport is then the
log one, so an app with no credentials starts, serves, and writes the message it
would have sent.

## The transport contract

```ts
export abstract class EmailTransport {
  abstract readonly name: string;
  abstract send(message: OutboundEmail): Promise<EmailResult>;
  verify?(): Promise<void>;
}
```

`verify` checks that the transport could send, without sending. It is optional
because only some backends can do it cheaply: nodemailer opens the connection
and runs the greeting and AUTH, while Resend has no call that is not a send, so
`SmtpTransport` has one and `ResendTransport` does not. A caller that finds none
has been told nothing, which is `unknown` to a health probe rather than `down`.

An abstract class rather than an interface, because a dunx constructor parameter
names a runtime value. `OutboundEmail` is the message after the module's
defaults have been applied: `from` is filled in, every recipient is an object,
and `to`, `cc`, `bcc`, `attachments` and `headers` are always present. A
transport maps that onto its provider and does nothing else.

| Transport         | Subpath                    | Peer         |
| ----------------- | -------------------------- | ------------ |
| `LogTransport`    | `@dunx/infra/email`        | none         |
| `MemoryTransport` | `@dunx/infra/email`        | none         |
| `ResendTransport` | `@dunx/infra/email/resend` | `resend`     |
| `SmtpTransport`   | `@dunx/infra/email/smtp`   | `nodemailer` |

Each vendor subpath reaches its peer through a static import, so
`@dunx/infra/email` on its own installs none of them.

There is no Bun SMTP client and SMTP is not a `fetch`: it is a stateful dialogue
over TCP with STARTTLS, AUTH and dot-stuffing. `Bun.connect` gives the socket and
nothing above it, so `SmtpTransport` is nodemailer rather than a hand-written
client.

## Dry runs

`dryRun: true` routes sends to `LogTransport` and leaves the configured one
bound. One variable is then the whole difference between an environment that
delivers and one that does not, and the log line carries the sender, the
recipients and the subject, with the bodies at `debug`.

`EmailResult.transport` says which one answered, so a test can assert that
nothing left the process.

## Rate limiting

Resend enforces a per-second cap and answers a breach with a 429 inside a job
handler. `maxPerSecond` spaces the starts of sends so the cap is not reached:

```ts
EmailModule.forRoot({ maxPerSecond: 2 });
```

Only the starts are serialised, not the sends, so several messages are in flight
at once while their starts stay `1000 / maxPerSecond` apart. The default is `0`,
which paces nothing.

The pacing is per process, the way `ScheduleModule`'s timers are: two replicas
each pace themselves and together send at twice the cap. A limit that has to
hold across a fleet belongs in front of the provider.

**Retries are off unless you ask for them.** A provider that accepted a message
and then lost the response cannot be told apart from one that never saw it, and
the cost of guessing wrong is a second email in a real inbox. `resilience` takes
the same `ResilienceOptionsInit` as everything else in dunx:

```ts
EmailModule.forRoot({
  resilience: { timeoutMs: 5_000, retry: { maxRetries: 2 } },
});
```

The pacer sits inside the policy, so a retry waits out the interval rather than
firing straight back into the cap that rejected it.

## Templates

`TemplateRenderer` turns a template and its props into an HTML body and a plain
text one. React Email is the shipped implementation and not the only possible
one: a tagged-template or MJML renderer satisfies the same two methods.

The peer is `@react-email/render`, the package holding `render`. Components for
authoring a template are the app's own choice; React Email has folded them into
`react-email`, the CLI this subpath exists to avoid, so `@dunx/infra` depends on
neither.

```tsx
// emails/welcome.tsx
import { Body, Container, Heading, Html } from '@react-email/components';

const Welcome = ({ name }: { name: string }) => (
  <Html lang="en">
    <Body>
      <Container>
        <Heading>Welcome, {name}</Heading>
      </Container>
    </Body>
  </Html>
);

Welcome.PreviewProps = { name: 'Ada' };

export default Welcome;
```

```ts
import Welcome from './emails/welcome.js';

await this.email.sendTemplate({
  to: 'ada@example.com',
  subject: 'Welcome',
  template: Welcome,
  props: { name: 'Ada' },
});
```

Both bodies come from one element: `render` runs again with `plainText`, so the
text alternative cannot describe a different email. The template is imported as
a value rather than named by a string, so renaming one is a compile error.

Under `moduleResolution: nodenext` a `.tsx` template is imported with a `.js`
extension like every other module, and the tsconfig needs `"jsx": "react-jsx"`.

## The preview server

```bash
bunx dunx-email preview ./emails     # http://localhost:3035
bunx dunx-email export ./emails --out ./out
```

The `react-email` CLI serves the same page by pulling in Next.js, esbuild,
chokidar and socket.io, and renders through the same `render` call. So this is
`Bun.serve`, `Bun.Glob` and `import()`: no CLI framework, no bundler, no dev
server. An edit shows up on the next request because the module is imported
again behind a cache-busting query.

It binds `127.0.0.1`. The routes are unauthenticated and one of them answers a
broken template with a stack trace, so reaching it from another machine is
opt-in through `hostname`.

| Flag               | Default                   |
| ------------------ | ------------------------- |
| `--port <n>`       | `3035`                    |
| `--out <dir>`      | `./out`                   |
| `--renderer <mod>` | `@dunx/infra/email/react` |

`--renderer` names a module whose default export is a `TemplateRenderer`, which
is how an app previewing MJML never installs `@react-email/components`. A
relative path is relative to where the shell is. Point it at the same instance
the module is configured with and the preview cannot drift from what a send
produces:

```ts
// src/email/render.ts
import { ReactEmailRenderer } from '@dunx/infra/email/react';

export default new ReactEmailRenderer();
```

Discovery takes every `.ts`, `.tsx`, `.js`, `.jsx` and `.mjs` module under the
directory and skips suites, `index` files, and names starting with `_` or `.`.
Anything else in there is rendered, so shared styles belong one directory up.

A name is the path without its extension, so `welcome.ts` beside `welcome.tsx`
is two files claiming one name and is refused rather than resolved by order.

The same class is available in-process, for a route serving a preview page:

```ts
import { EmailPreview } from '@dunx/infra/email';
```

## Writing a transport

Subclass `EmailTransport` and map `OutboundEmail` onto the provider. `toPayload`
is the walk both shipped transports take, so a field added to `OutboundEmail`
reaches every provider at once rather than one at a time:

```ts
import { toPayload, withContentType } from '@dunx/infra/email';

const body = toPayload(message, {
  recipients: (list) => list.map(formatAddress),
  attachment: (file) => withContentType(file, file.content),
});
```

## Testing

`MemoryTransport` keeps what it was given instead of sending it. It is an
`EmailTransport` like any other, so overriding the binding is the whole setup:

```ts
const transport = new MemoryTransport();

const app = await createTestApp({
  modules: [MailModule],
  overrides: [provide(EmailTransport, { useValue: transport })],
});

await app.get(Notices).welcome('ada@example.com', 'Ada');

expect(transport.last?.subject).toBe('Welcome, Ada');
expect(transport.to('ada@example.com')).toHaveLength(1);
```

`EmailService.resolve` applies the defaults and returns the message without
sending it, for a test that cares about the addressing rather than the body.

## Addresses

A recipient is either a bare address, `Name <address>` as one string, or
`{ address, name }`. All three go through `toAddress`, which splits the second
form and refuses anything that cannot be put in a header: a newline, a comma, a
semicolon, a stray angle bracket, or an address with no `@`.

```ts
toAddress('Ops <ops@example.com>'); // { address: 'ops@example.com', name: 'Ops' }
toAddress('a@example.com,evil@attacker.com'); // throws InvalidAddressError
```

Refused rather than escaped, because there is no rendering of two addresses
inside one recipient that means what the caller wrote. SMTP joins a recipient
list into one comma-separated header, so a comma that survived would become a
second `RCPT` the caller never asked for.

The subject is a header too, and so is every entry in `headers`. Both go through
the same newline check, so a name interpolated into a subject cannot add a
`Bcc`.

## Errors

| Error                   | Raised when                            | `status` |
| ----------------------- | -------------------------------------- | -------- |
| `MissingSenderError`    | no `from` on the message or the module | none     |
| `MissingRecipientError` | nothing on `to`, `cc` or `bcc`         | 400      |
| `EmailSendError`        | a transport refused the message        | 502      |

All three extend `EmailError`, which extends `AppError`, so `@dunx/http`'s
default mapper turns the status into a response without either package importing
the other.
