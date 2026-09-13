import { Logger } from '@dunx/core';
import {
  discoverTemplates,
  EmailService,
  EmailTransport,
  MemoryTransport,
} from '@dunx/infra/email';
import { join } from 'node:path';
import { AppConfigService } from '../config.js';
import { Notices } from './notices.service.js';
import Welcome from './templates/welcome.js';

const TEMPLATES = join(import.meta.dir, 'templates');

export class MailDemo {
  constructor(
    private readonly email: EmailService,
    private readonly transport: EmailTransport,
    private readonly notices: Notices,
    private readonly config: AppConfigService,
    private readonly logger: Logger,
  ) {}

  async demonstrate(): Promise<void> {
    const { logger } = this;
    const configured = this.config.get('email');

    logger.info(
      `transport ${this.transport.name}, configured ${configured.transport}` +
        `, dryRun=${String(configured.dryRun)}`,
    );

    // The module's `from` and the pacing are applied here, not at the call site.
    const outbound = this.email.resolve({
      to: 'ada@example.com',
      subject: 'Hi',
    });
    logger.info(`resolve   from -> ${outbound.from.address}`);

    const rendered = await this.email.render(Welcome, {
      name: 'Ada',
      appUrl: this.config.get('publicUrl'),
    });
    logger.info(
      `render    welcome -> ${String(rendered.html.length)} bytes html, ` +
        `${String(rendered.text?.length ?? 0)} bytes text`,
    );

    const result = await this.notices.welcome('ada@example.com', 'Ada');
    logger.info(
      `send      welcome -> ${result.transport}, accepted ` +
        JSON.stringify(result.accepted),
    );

    // The same discovery `bunx dunx-email preview` runs, over this app's own
    // templates directory.
    const templates = await discoverTemplates(TEMPLATES);
    logger.info(`preview   ${JSON.stringify(templates.map((t) => t.name))}`);

    // What a test asserts against. Nothing in the app is configured with it.
    const memory = new MemoryTransport();
    await memory.send(outbound);
    logger.info(`memory    captured ${String(memory.sent.length)} message(s)`);
  }
}
