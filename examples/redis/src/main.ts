import { AppFactory } from '@dunx/core';
import {
  isConnectionError,
  RedisConnection,
  RedisError,
  RedisOptions,
} from '@dunx/redis';
import { AppModule } from './app.module.js';
import { LeaderboardService } from './leaderboard.service.js';
import { NotificationsService } from './notifications.service.js';
import { SessionsService } from './sessions.service.js';

const log = (line: string): void => {
  console.log(`[dunx] ${line}`);
};

// Booting touches no socket: connections are lazy and `eager` is off, so the
// container comes up whether or not there is a server to talk to.
const app = await AppFactory.create(AppModule);
app.enableShutdownHooks();

const redis = app.get(RedisConnection);
const options = app.get(RedisOptions);
log(`container up — ${options.redactedUrl}`);

// Any Redis-level failure means there is nothing to demonstrate against, which is
// the normal case in CI. Anything else is a real bug and still propagates.
let unreachable: RedisError | undefined;
const pong = await redis.ping().then(
  (reply) => reply,
  (error: unknown) => {
    if (error instanceof RedisError) {
      unreachable = error;
      return undefined;
    }
    throw error;
  },
);

if (unreachable || pong === undefined) {
  const why = isConnectionError(unreachable)
    ? 'no server answering'
    : `unusable (${unreachable?.code})`;
  log(`${why} at ${options.redactedUrl} — skipping the round trip`);
  await app.shutdown();
  process.exit(0);
}

log(`PING -> ${pong}`);

const leaderboard = app.get(LeaderboardService);
const sessions = app.get(SessionsService);
const notifications = app.get(NotificationsService);

await leaderboard.reset();
await leaderboard.record({ player: 'ada', score: 12 });
await leaderboard.record({ player: 'grace', score: 30 });
await leaderboard.record({ player: 'alan', score: 21 });
log(`HINCRBY ada +9 -> ${await leaderboard.bump('ada', 9)}`);

const standings = await leaderboard.standings();
log(`${await leaderboard.players()} players ranked:`);
for (const [index, entry] of standings.entries()) {
  log(`  ${index + 1}. ${entry.player.padEnd(6)} ${entry.score}`);
}

log(
  `SET NX session s-1 -> ${(await sessions.open('s-1', 'ada', 60)) ? 'created' : 'already existed'}`,
);
log(
  `SET NX again       -> ${(await sessions.open('s-1', 'grace', 60)) ? 'created' : 'refused'}`,
);
log(
  `GET session s-1    -> ${await sessions.read('s-1')} (ttl ${await sessions.ttl('s-1')}s)`,
);
log(`CLIENT GETNAME     -> ${await sessions.serverName()}`);
log(`GETDEL session     -> ${await sessions.close('s-1')}`);

await notifications.listen();
log('SUBSCRIBE dunx:example:events (on a second connection)');
log(
  `commands still work while subscribed -> ${await notifications.stillUsableWhileSubscribed()}`,
);
log(
  `PUBLISH -> delivered to ${await notifications.announce('deploy finished')} subscriber(s)`,
);
await Bun.sleep(100);
log(`received: ${JSON.stringify(notifications.received)}`);
await notifications.stop();

await leaderboard.reset();
await redis.del('dunx:example:probe');

if (process.env['DUNX_HOLD']) {
  log('holding — send SIGTERM to close');
  await app.closed;
} else {
  await app.shutdown();
}
log(`connection closed -> ${!redis.connected}`);
