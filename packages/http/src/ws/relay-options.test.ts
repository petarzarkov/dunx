import { expect, test } from 'bun:test';
import { Module } from '@dunx/core';
import { HttpFactory } from '../server/factory.js';
import type { PubSubRelay } from './relay.js';

@Module({})
class AppModule {}

test('HttpOptions.relayResubscribe reaches the relay', async () => {
  let attempts = 0;
  const relay: PubSubRelay = {
    // Never reached: the subscribe below fails first, every time.
    publish: async () => Promise.resolve(),
    subscribe: async () => {
      attempts += 1;
      throw new Error('broker down');
    },
  };

  const app = await HttpFactory.create(AppModule, {
    port: 0,
    requestLogging: false,
    relay,
    relayResubscribe: { attempts: 2, delayMs: 1 },
  });
  await app.listen();

  // One initial subscribe plus the two retries the option asked for, inside a
  // 60ms window because `delayMs` is 1. Verified to read 1 without the
  // passthrough: the default 500ms first delay has not elapsed by then, so the
  // assertion is measuring the option and not just that retries happen at all.
  await Bun.sleep(60);
  expect(attempts).toBe(3);

  await app.shutdown();
});
