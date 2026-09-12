import { afterAll, beforeAll, expect, it } from 'bun:test';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import {
  createConnectTransport,
  createGrpcWebTransport,
} from '@connectrpc/connect-web';
import { ConnectMiddleware, ConnectRegistry } from '@dunx/http/connect';
import { createTestServer, type TestServer } from '@dunx/testing';
import { GreetService } from './rpc/greet_pb.js';
import { Greetings } from './rpc/greetings.service.js';
import { RpcModule } from './rpc/rpc.module.js';

/**
 * The feature on its own, the way `throttle.test.ts` does it: one module, a real
 * server on port 0, and clients that speak the wire protocols rather than
 * calling the implementation directly.
 */
let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({
    modules: [RpcModule],
    middleware: [ConnectMiddleware],
  });
});

afterAll(async () => {
  await server.close();
});

const connectClient = () =>
  createClient(GreetService, createConnectTransport({ baseUrl: server.url }));

it('mounts one path per RPC, at the paths a Connect client looks for', () => {
  const registry = server.app.get(ConnectRegistry);
  expect(registry.methods.map((method) => method.path)).toEqual([
    '/greet.v1.GreetService/Say',
    '/greet.v1.GreetService/Countdown',
  ]);
  // gRPC needs a trailer that Bun.serve cannot send, so it is never offered.
  for (const method of registry.methods) {
    expect(method.protocols).not.toContain('grpc');
  }
});

it('answers a Connect client and reaches the injected provider', async () => {
  const before = server.app.get(Greetings).total;
  const said = await connectClient().say({ name: 'suite' });

  expect(said.text).toBe('Hello suite');
  // The count comes off `Greetings`, which GreetRpc got by constructor - so the
  // RPC ran through the container rather than a bare `new`.
  expect(said.greeted).toBe(before + 1);
  expect(server.app.get(Greetings).total).toBe(before + 1);
});

it('streams every message of a server-streaming RPC', async () => {
  const texts: string[] = [];
  for await (const message of connectClient().countdown({
    name: 'tick',
    from: 4,
  })) {
    texts.push(message.text);
  }
  expect(texts).toEqual(['tick 4', 'tick 3', 'tick 2', 'tick 1']);
});

it('answers a gRPC-Web client on the same port', async () => {
  const client = createClient(
    GreetService,
    createGrpcWebTransport({ baseUrl: server.url }),
  );
  expect((await client.say({ name: 'web' })).text).toBe('Hello web');

  const texts: string[] = [];
  for await (const message of client.countdown({ name: 'gw', from: 2 })) {
    texts.push(message.text);
  }
  expect(texts).toEqual(['gw 2', 'gw 1']);
});

it('carries a thrown ConnectError through as its status code', async () => {
  const failed = connectClient().say({ name: '  ' });
  await expect(failed).rejects.toThrow(ConnectError);
  await failed.catch((error: unknown) => {
    expect(ConnectError.from(error).code).toBe(Code.InvalidArgument);
  });
});

it('answers a plain JSON POST, which is what curl sends', async () => {
  const response = await server.request('greet.v1.GreetService/Say', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'curl' }),
  });

  expect(response.status).toBe(200);
  expect((await response.json()) as { text: string }).toMatchObject({
    text: 'Hello curl',
  });
});

it('refuses a native gRPC call with an explanation, not a broken reply', async () => {
  const response = await server.request('greet.v1.GreetService/Say', {
    method: 'POST',
    headers: { 'content-type': 'application/grpc' },
    body: new Uint8Array([0, 0, 0, 0, 0]),
  });

  expect(response.status).toBe(415);
  const body = (await response.json()) as { code: string; message: string };
  expect(body.code).toBe('unimplemented');
  expect(body.message).toContain('trailer');
});

it('leaves a path no RPC claims to the usual 404', async () => {
  const response = await server.request('greet.v1.GreetService/Nope', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(404);
});
