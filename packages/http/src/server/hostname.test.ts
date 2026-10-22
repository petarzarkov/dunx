import { expect, it } from 'bun:test';
import { Module, provide } from '@dunx/core';
import { Controller, Get } from '../route/decorators.js';
import { Gateway, OnMessage } from '../ws/decorators.js';
import { HttpFactory } from './factory.js';
import { HttpOptionsProvider, resolveHttpOptions } from './options-provider.js';
import { serving } from './serving.fixture.js';

@Controller('hello')
class HelloController {
  @Get()
  hello() {
    return { ok: true };
  }
}

@Gateway('/socket')
class EchoGateway {
  @OnMessage()
  echo(message: string | Buffer) {
    return String(message);
  }
}

class LoopbackOptions extends HttpOptionsProvider {
  override get hostname() {
    return '127.0.0.1';
  }
}

@Module({
  controllers: [HelloController],
  providers: [
    EchoGateway,
    provide(HttpOptionsProvider, { useClass: LoopbackOptions }),
  ],
})
class AppModule {}

for (const split of [false, true]) {
  it(`binds the configured host with split=${split}`, async () => {
    await serving(
      () =>
        HttpFactory.create(AppModule, {
          bootLogging: false,
          requestLogging: false,
          ...(split ? { gatewayPort: 0 } : {}),
        }),
      async (app, url) => {
        expect(new URL(url).hostname).toBe('127.0.0.1');
        expect(await (await fetch(`${url}/hello`)).json()).toEqual({
          ok: true,
        });
        const socketUrl = new URL('/socket', app.gatewayUrl ?? url);
        expect(socketUrl.hostname).toBe('127.0.0.1');
        socketUrl.protocol = 'ws:';
        const socket = new WebSocket(socketUrl);
        try {
          const echoed = await new Promise<string>((resolve, reject) => {
            socket.onopen = () => socket.send('hello');
            socket.onmessage = (event) => resolve(String(event.data));
            socket.onerror = () =>
              reject(new Error('websocket connection failed'));
          });
          expect(echoed).toBe('hello');
        } finally {
          socket.close();
        }
      },
    );
  });
}

it('lets direct options override the provider, including explicit undefined', () => {
  const settings = new LoopbackOptions();
  expect(resolveHttpOptions(settings, {}).hostname).toBe('127.0.0.1');
  expect(resolveHttpOptions(settings, { hostname: 'localhost' }).hostname).toBe(
    'localhost',
  );
  expect(
    resolveHttpOptions(settings, { hostname: undefined }).hostname,
  ).toBeUndefined();
});
