import { Module } from '@dunx/core';
import { HttpFactory, type HttpApp } from '../server/factory.js';
import { Gateway, OnOpen } from './decorators.js';
import type { PubSubRelay } from './relay.js';
import type { Socket } from './socket.js';

/**
 * What `redis-relay.test.ts` and `postgres-relay.test.ts` both need: two real
 * nodes, a socket on each, and a subprocess runner that can see an event loop a
 * relay failed to release.
 */
export const TOPIC = 'lobby';

@Gateway('/live')
class LiveGateway {
  @OnOpen()
  opened(socket: Socket): void {
    socket.subscribe(TOPIC);
    socket.send('ready');
  }
}

@Module({ providers: [LiveGateway] })
export class AppModule {}

/** A client that keeps every frame, so a *second* delivery is visible. */
export interface Client {
  readonly frames: string[];
  close(): void;
}

export const until = async (done: () => boolean, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await Bun.sleep(5);
  }
};

export const opened = async (socket: WebSocket): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('the socket never opened')),
      2000,
    );
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
};

export const socketFor = (base: string): WebSocket =>
  new WebSocket(new URL('/live', base).href.replace(/^http/, 'ws'));

export const open = async (base: string): Promise<Client> => {
  const socket = socketFor(base);
  const frames: string[] = [];
  socket.addEventListener('message', (event: MessageEvent) => {
    frames.push(String(event.data));
  });
  await opened(socket);
  // 'ready' is sent from @OnOpen and would otherwise be counted as a delivery.
  await until(() => frames.length === 1);
  frames.length = 0;
  return { frames, close: () => socket.close() };
};

export const twoNodes = async (
  relayA: PubSubRelay,
  relayB: PubSubRelay,
  channel: string,
): Promise<{ apps: HttpApp[]; urls: string[] }> => {
  const apps: HttpApp[] = [];
  const urls: string[] = [];
  for (const relay of [relayA, relayB]) {
    const app = await HttpFactory.create(AppModule, {
      requestLogging: false,
      relay,
      relayChannel: channel,
    });
    urls.push(await app.listen(0));
    apps.push(app);
  }
  return { apps, urls };
};

export const stop = async (apps: readonly HttpApp[]): Promise<void> => {
  for (const app of apps) await app.shutdown();
};

/**
 * Runs `body` against a real relay in a subprocess, calls `close()`, and answers
 * the exit code - `0` only if nothing kept the event loop alive. `bun test` exits
 * the runner itself, so a held-open loop is invisible in-process.
 */
export const released = async (
  moduleFile: string,
  exportName: string,
  body: string,
): Promise<number> => {
  const module = new URL(moduleFile, import.meta.url).pathname;
  const proc = Bun.spawn(
    [
      'bun',
      '-e',
      `const { ${exportName} } = await import(${JSON.stringify(module)});\n` +
        `${body}await relay.close();\nconsole.log('released');\n`,
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  const timer = setTimeout(() => proc.kill(), 8000);
  const code = await proc.exited;
  clearTimeout(timer);
  return code;
};
