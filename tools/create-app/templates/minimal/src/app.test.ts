import { describe, expect, test } from 'bun:test';
import { createTestServer } from '@dunx/testing';
import { AppModule } from './app.module.js';

describe('minimal', () => {
  test('serves the greeting', async () => {
    const server = await createTestServer({ modules: [AppModule] });

    const { status, body } = await server.json<{ greeting: string }>(
      'greetings/ada',
    );

    expect(status).toBe(200);
    expect(body.greeting).toBe('hello, ada');
    await server.close();
  });
});
