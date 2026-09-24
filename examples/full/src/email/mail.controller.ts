import { Controller, Get, Post, type Input } from '@dunx/http';
import { EmailService, EmailTransport } from '@dunx/infra/email';
import { z } from 'zod';
import { Notices } from './notices.service.js';

const SendWelcome = z
  .object({
    to: z.email(),
    name: z.string().min(1).max(60).default('Ada'),
  })
  .meta({ id: 'SendWelcome', description: 'Who the welcome email goes to' });

const sendWelcome = { body: SendWelcome } as const;
const previewTemplate = {
  query: z.object({ name: z.string().min(1).max(60).default('Ada') }),
} as const;

/**
 * Injects `EmailService` and the bound `EmailTransport`, the second only so the
 * route can say which one answered. Nothing here names a vendor.
 */
@Controller('email')
export class MailController {
  constructor(
    private readonly email: EmailService,
    private readonly transport: EmailTransport,
    private readonly notices: Notices,
  ) {}

  @Get('/')
  transportInUse(): { transport: string } {
    return { transport: this.transport.name };
  }

  @Post('/welcome', sendWelcome)
  async welcome({ body }: Input<typeof sendWelcome>): Promise<{
    id: string | undefined;
    accepted: readonly string[];
    transport: string;
  }> {
    return this.notices.welcome(body.to, body.name);
  }

  /**
   * The rendered HTML without sending anything, which is the same `render` the
   * send path calls and the same one `bunx dunx-email preview` serves.
   */
  @Get('/preview', previewTemplate)
  async preview({ query }: Input<typeof previewTemplate>): Promise<Response> {
    const { default: Welcome } = await import('./templates/welcome.js');
    const rendered = await this.email.render(Welcome, {
      name: query.name,
      appUrl: 'https://demo.dunx.win',
    });
    return new Response(rendered.html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // An email is inline styles and remote images, and never runs a script.
        // A header set here is kept over the app's `securityHeaders` policy.
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; img-src * data:",
      },
    });
  }
}
