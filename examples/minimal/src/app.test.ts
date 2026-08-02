import { describe, expect, test } from 'bun:test';
import { createTestServer } from '@dunx/testing';
import { AppModule } from './app.module.js';

/**
 * The whole app behind a real `Bun.serve` on port 0. This is also what CI runs to
 * prove the example still boots — see `examples/testing` for overrides and the
 * rest of `@dunx/testing`.
 */
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
