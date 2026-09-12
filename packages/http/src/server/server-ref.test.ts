import { describe, expect, it } from 'bun:test';
import { ServerRef } from './server-ref.js';

describe('ServerRef', () => {
  it('is a no-op before listen() has bound a server', () => {
    expect(() =>
      new ServerRef().keepAlive(new Request('http://rpc.test/')),
    ).not.toThrow();
  });

  it('clears the deadline on the server it was attached to', () => {
    const ref = new ServerRef();
    const cleared: number[] = [];
    const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
    const real = server.timeout.bind(server);
    server.timeout = (req: Request, seconds: number): void => {
      cleared.push(seconds);
      real(req, seconds);
    };

    ref.attach(server);
    ref.keepAlive(new Request(`http://localhost:${server.port}/`));
    expect(cleared).toEqual([0]);
    void server.stop(true);
  });
});
