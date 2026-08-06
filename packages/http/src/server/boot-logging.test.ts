import { describe, expect, test } from 'bun:test';
import { ConsoleLogger, Logger, Module, provide } from '@dunx/core';
import { Controller, Get, Post } from '../route/decorators.js';
import { Gateway, OnMessage } from '../ws/decorators.js';
import { HttpFactory } from './factory.js';

/**
 * What the process serves, logged once when the table is final.
 *
 * Nest answers "is my route registered" with a line per controller and a line per
 * route; dunx answers it with one entry carrying the table, which is the shape
 * `WorkerFactory`'s "Consuming N job(s) on M queue(s)" already set for the consuming
 * side. Before this, a dunx app logged nothing at all at boot.
 */
interface Entry {
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

class Recorder extends ConsoleLogger {
  readonly entries: Entry[] = [];

  constructor() {
    super(undefined, 'info', false);
  }

  override info(message: unknown, ...rest: unknown[]): void {
    this.entries.push({
      message: String(message),
      fields: (rest[0] as Record<string, unknown>) ?? {},
    });
  }
}

@Controller('reports')
class ReportsController {
  @Get('/')
  list(): { ok: true } {
    return { ok: true };
  }

  @Post('/')
  create(): { ok: true } {
    return { ok: true };
  }
}

@Gateway('/ws')
class ChatGateway {
  readonly seen: string[] = [];

  @OnMessage('chat')
  chat(): void {
    this.seen.push('chat');
  }

  @OnMessage('typing')
  typing(): void {
    this.seen.push('typing');
  }
}

const boot = async (recorder: Recorder) => {
  @Module({
    controllers: [ReportsController],
    providers: [ChatGateway, provide(Logger, { useValue: recorder })],
    exports: [Logger],
    global: true,
  })
  class AppModule {}

  return HttpFactory.create(AppModule, { requestLogging: false });
};

describe('boot logging', () => {
  test('reports every route on the final, prefixed paths', async () => {
    const recorder = new Recorder();
    const app = await boot(recorder);
    app.setGlobalPrefix('api');
    await app.listen(0);

    const served = recorder.entries.find((entry) =>
      entry.message.startsWith('Serving'),
    );
    expect(served?.message).toBe('Serving 2 route(s) and 1 gateway(s)');
    // Prefixed: `setGlobalPrefix` runs after create(), so logging at create() would
    // have named paths that do not exist.
    expect(served?.fields['routes']).toEqual([
      'GET /api/reports',
      'POST /api/reports',
    ]);
    expect(served?.fields['gateways']).toEqual([
      { path: '/ws', gateway: 'ChatGateway', events: ['chat', 'typing'] },
    ]);

    await app.shutdown();
  });

  test('omits the gateway field entirely when there are none', async () => {
    const recorder = new Recorder();

    @Module({
      controllers: [ReportsController],
      providers: [provide(Logger, { useValue: recorder })],
      exports: [Logger],
      global: true,
    })
    class NoSockets {}

    const app = await HttpFactory.create(NoSockets, { requestLogging: false });
    await app.listen(0);

    const served = recorder.entries.find((entry) =>
      entry.message.startsWith('Serving'),
    );
    expect(served?.message).toBe('Serving 2 route(s)');
    expect(served?.fields).not.toHaveProperty('gateways');

    await app.shutdown();
  });
});
