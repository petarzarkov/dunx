import { AppFactory, Logger, Module, provide, token } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { Quiet } from '../quiet.fixture.js';
import { LogTransport } from './log.js';
import { MemoryTransport } from './memory.js';
import { EmailModule } from './module.js';
import { EmailOptions } from './options.js';
import { TemplateRenderer, UnconfiguredRenderer } from './renderer.js';
import { EmailService } from './service.js';
import { EmailTransport } from './transport.js';

/**
 * `bun test` runs from source with no `@dunx/transform` preload, so the record
 * the plugin would have appended is written by hand.
 */
class Welcomes {
  constructor(private readonly email: EmailService) {}

  greet(to: string): Promise<unknown> {
    return this.email.send({ to, subject: 'Welcome' });
  }
}
Object.defineProperty(Welcomes, Symbol.for('dunx.deps'), {
  value: () => [EmailService],
});

const quiet = provide(Logger, { useValue: new Quiet() });

describe('EmailModule.forRoot', () => {
  it('binds the options, the transport, the renderer and the service', async () => {
    @Module({
      imports: [EmailModule.forRoot({ from: 'ops@example.com' })],
      providers: [quiet],
    })
    class AppModule {}
    const app = await AppFactory.create(AppModule);

    expect(app.get(EmailOptions).from).toEqual({ address: 'ops@example.com' });
    expect(app.get(EmailTransport)).toBeInstanceOf(LogTransport);
    expect(app.get(TemplateRenderer)).toBeInstanceOf(UnconfiguredRenderer);
    expect(app.get(EmailService)).toBeInstanceOf(EmailService);
    await app.shutdown();
  });

  it('binds the transport it was handed rather than a second one', async () => {
    const transport = new MemoryTransport();
    @Module({
      imports: [EmailModule.forRoot({ transport, from: 'ops@example.com' })],
      providers: [quiet],
    })
    class AppModule {}
    const app = await AppFactory.create(AppModule);

    expect(app.get(EmailTransport)).toBe(transport);
    await app.shutdown();
  });

  // One definition of sending nowhere, reached two ways: nothing configured,
  // and a configured transport that `dryRun` sets aside.
  it('routes a dry run to the log transport, keeping the configured one', async () => {
    const transport = new MemoryTransport();
    @Module({
      imports: [
        EmailModule.forRoot({
          transport,
          dryRun: true,
          from: 'ops@example.com',
        }),
      ],
      providers: [quiet],
    })
    class AppModule {}
    const app = await AppFactory.create(AppModule);

    const result = await app
      .get(EmailService)
      .send({ to: 'a@example.com', subject: 'Hi' });

    expect(result.transport).toBe('log');
    expect(transport.sent).toHaveLength(0);
    expect(app.get(EmailOptions).transport).toBe(transport);
    await app.shutdown();
  });

  it('injects EmailService into a consumer through its constructor', async () => {
    const transport = new MemoryTransport();
    @Module({
      imports: [EmailModule.forRoot({ transport, from: 'ops@example.com' })],
      providers: [quiet, Welcomes],
    })
    class AppModule {}
    const app = await AppFactory.create(AppModule);

    await app.get(Welcomes).greet('a@example.com');

    expect(transport.last?.subject).toBe('Welcome');
    await app.shutdown();
  });
});

describe('EmailModule.forRootAsync', () => {
  it('builds the options from a factory', async () => {
    const transport = new MemoryTransport();
    @Module({
      imports: [
        EmailModule.forRootAsync({
          useFactory: () =>
            Promise.resolve({ transport, from: 'ops@example.com' }),
        }),
      ],
      providers: [quiet],
    })
    class AppModule {}
    const app = await AppFactory.create(AppModule);

    expect(app.get(EmailTransport)).toBe(transport);
    await app.shutdown();
  });

  // A dynamic module is its own scope, so the factory's dependency has to come
  // from `imports` rather than from beside it.
  it('injects from its own imports', async () => {
    const sender = token<string>('sender');
    @Module({
      providers: [provide(sender, { useValue: 'ops@example.com' })],
      exports: [sender],
    })
    class SettingsModule {}
    @Module({
      imports: [
        EmailModule.forRootAsync({
          imports: [SettingsModule],
          useFactory: (from: string) => ({ from }),
          inject: [sender],
        }),
      ],
      providers: [quiet],
    })
    class AppModule {}
    const app = await AppFactory.create(AppModule);

    expect(app.get(EmailOptions).from).toEqual({ address: 'ops@example.com' });
    await app.shutdown();
  });
});
