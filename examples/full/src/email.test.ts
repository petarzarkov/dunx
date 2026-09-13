import { afterAll, beforeAll, expect, it } from 'bun:test';
import { provide, type App } from '@dunx/core';
import {
  EmailService,
  EmailTransport,
  MemoryTransport,
} from '@dunx/infra/email';
import { createTestApp } from '@dunx/testing';
import { configModule } from './config.js';
import { MailModule } from './email/email.module.js';
import { Notices } from './email/notices.service.js';

/**
 * The mail slice on its own, with the transport replaced rather than stubbed:
 * `MemoryTransport` is an `EmailTransport` like any other, so what is asserted
 * is the message the configured provider would have received.
 */
let app: App;
const transport = new MemoryTransport();

beforeAll(async () => {
  app = await createTestApp({
    modules: [configModule(), MailModule],
    overrides: [provide(EmailTransport, { useValue: transport })],
  });
});

afterAll(() => app.shutdown());

it('sends the welcome template through the bound transport', async () => {
  transport.clear();

  const result = await app.get(Notices).welcome('ada@example.com', 'Ada');

  expect(result.transport).toBe('memory');
  expect(transport.sent).toHaveLength(1);
  expect(transport.last?.subject).toBe('Welcome to dunx-full, Ada');
  expect(transport.last?.from.address).toBe('dunx-full <no-reply@dunx.win>');
  // React puts a comment between two adjacent text nodes, so the assertion is
  // on the end of the heading rather than on the whole phrase.
  expect(transport.last?.html).toContain('Ada</h1>');
  expect(transport.last?.html).toContain('Open the app');
  // The plain-text alternative comes from the same element, so a template with
  // no text branch still produces one.
  expect(transport.last?.text).toContain('ADA');
});

it('renders the receipt template with its own props', async () => {
  transport.clear();

  await app
    .get(Notices)
    .receipt('ada@example.com', 'INV-1', [
      { description: 'Widgets', amount: 5 },
    ]);

  expect(transport.last?.html).toContain('INV-1');
  expect(transport.last?.html).toContain('Widgets');
  expect(transport.last?.html).toContain('£5.00');
});

it('applies the module sender without a send', () => {
  const outbound = app
    .get(EmailService)
    .resolve({ to: 'ada@example.com', subject: 'Hi' });

  expect(outbound.from.address).toBe('dunx-full <no-reply@dunx.win>');
  expect(outbound.to).toEqual([{ address: 'ada@example.com' }]);
});
