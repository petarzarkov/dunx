import { AppFactory } from '@dunx/core';
import { createWsAdapter, PubSub, WsSettings, type SocketData } from '@dunx/ws';
import { AppModule } from './app.module.js';
import { connect } from './client.js';
import { Rooms } from './rooms.service.js';

// Nothing here may block: if a frame never arrives the run fails instead of
// hanging, and the server is stopped either way.
const deadline = setTimeout(() => {
  console.error('[dunx] timed out');
  process.exit(1);
}, 15_000);

const step = (message: string): void => console.log(`[dunx] ${message}`);

const app = await AppFactory.create(AppModule);
app.enableShutdownHooks();

// The @dunx/http integration point: the adapter hands over exactly what Bun.serve
// wants, and this file is what calls Bun.serve.
const ws = createWsAdapter(app);
const server = Bun.serve<SocketData>({
  port: app.get(WsSettings).port ?? 0,
  websocket: ws.websocket,
  fetch: (req, srv) => ws.upgrade(req, srv),
});
ws.attach(server);

const rooms = app.get(Rooms);
const pubsub = app.get(PubSub);
const base = server.url.href.replace(/^http/, 'ws');

try {
  step(`listening on ${base} — gateways at ${ws.paths.join(', ')}`);

  const refused = await fetch(new URL('/chat', server.url));
  step(
    `plain GET /chat with no ?user= -> ${refused.status} ${await refused.text()}`,
  );

  const alice = await connect(`${base}chat?user=alice`, 'alice');
  step(`alice connected, @OnOpen said: ${await alice.next()}`);

  alice.send('hello there');
  step(`raw @OnMessage() replied: ${await alice.next()}`);

  alice.event('chat.nope', 'no handler claims this event');
  step(
    `unclaimed event fell through to the raw handler: ${await alice.next()}`,
  );

  const bob = await connect(`${base}chat?user=bob`, 'bob');
  step(`bob connected, @OnOpen said: ${await bob.next()}`);

  alice.event('chat.join', 'general');
  bob.event('chat.join', 'general');
  step(`alice joined: ${await alice.next()}`);
  step(`bob joined: ${await bob.next()}`);
  step(
    `injected Rooms service sees ${JSON.stringify(rooms.members('general'))}, ` +
      `Bun counts ${pubsub.subscriberCount('general')} subscribers`,
  );

  alice.event('chat.say', { room: 'general', text: 'first!' });
  step(`alice got the broadcast: ${await alice.next()}`);
  step(`bob got the same broadcast: ${await bob.next()}`);

  pubsub.publishEvent('general', 'chat.said', {
    from: 'server',
    text: 'ship it',
  });
  step(`publish with no socket held — alice: ${await alice.next()}`);
  step(`publish with no socket held — bob:   ${await bob.next()}`);

  alice.close();
  bob.close();
  await Bun.sleep(50);
  step(
    `@OnClose ran ${rooms.closed} times, #general is now ` +
      JSON.stringify(rooms.members('general')),
  );
} catch (error) {
  console.error('[dunx] failed:', error);
  process.exitCode = 1;
} finally {
  // Forced: a graceful stop waits for open sockets, which never close on their own.
  await server.stop(true);
  await app.shutdown();
  clearTimeout(deadline);
  step('server stopped, providers torn down');
}
