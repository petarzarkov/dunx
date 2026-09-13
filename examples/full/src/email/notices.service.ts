import { EmailService, type EmailResult } from '@dunx/infra/email';
import { AppConfigService } from '../config.js';
import Receipt, { type ReceiptLine } from './templates/receipt.js';
import Welcome from './templates/welcome.js';

/**
 * Injects `EmailService`, never a transport - swapping Resend for SMTP is then
 * one variable in the environment and nothing here changes.
 *
 * The templates are imported as values and handed to `sendTemplate`, which is
 * the same `render` call `dunx-email preview` makes. There is no template name
 * resolved from a string at runtime, so a renamed template is a compile error.
 */
export class Notices {
  constructor(
    private readonly email: EmailService,
    private readonly config: AppConfigService,
  ) {}

  welcome(to: string, name: string): Promise<EmailResult> {
    return this.email.sendTemplate({
      to,
      subject: `Welcome to dunx-full, ${name}`,
      template: Welcome,
      props: { name, appUrl: this.config.get('publicUrl') },
    });
  }

  receipt(
    to: string,
    reference: string,
    lines: readonly ReceiptLine[],
  ): Promise<EmailResult> {
    return this.email.sendTemplate({
      to,
      subject: `Receipt ${reference}`,
      template: Receipt,
      props: { reference, lines },
    });
  }
}
