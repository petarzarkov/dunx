"""The io scenario's clients for both Python subjects.

Two shapes, because the subjects are two shapes. Django is synchronous WSGI, so
it gets `redis` and a `psycopg_pool.ConnectionPool`; FastAPI is async ASGI, so it
gets `redis.asyncio` and an `AsyncConnectionPool`. Both are the same library and
the same pool size, and both do the same two round trips in the same order.

Connected only when the harness passes both URLs, so the other four scenarios run
an interpreter that has imported no driver and opened no socket.

**Django's calls block its gunicorn worker.** With one worker that is one request
in flight for the whole round trip - see the README, "Blocking subjects on the io
scenario".
"""

import json
import os

REDIS_KEY = "bench:greeting"
ROW_ID = 1
POOL_SIZE = 8
SELECT = "SELECT id, memo, amount FROM bench_ledger WHERE id = %s"

# Compact separators, the way the rest of both subjects writes JSON. The harness
# compares bytes.
COMPACT = (",", ":")


def urls():
    """`None` when the harness did not enable the scenario."""
    pg = os.environ.get("BENCH_IO_PG_URL")
    redis_url = os.environ.get("BENCH_IO_REDIS_URL")
    if not pg or not redis_url:
        return None
    return pg, redis_url


def payload(cached, row):
    """Key order is JSON key order in CPython, and the harness compares bytes."""
    if row is None:
        return {"cached": cached or "missing", "id": 0, "memo": "missing", "amount": 0}
    return {
        "cached": cached or "missing",
        "id": row[0],
        "memo": row[1],
        "amount": row[2],
    }


def encode(body):
    return json.dumps(body, separators=COMPACT).encode()


class SyncIo:
    """Django's client: blocking redis and a blocking psycopg pool."""

    def __init__(self, pg_url, redis_url):
        import psycopg_pool
        import redis

        self.pool = psycopg_pool.ConnectionPool(
            pg_url, min_size=1, max_size=POOL_SIZE, open=True
        )
        # BlockingConnectionPool, not the default. redis-py's plain pool raises
        # MaxConnectionsError the moment it is exhausted rather than waiting for a
        # free connection, and every other client in this suite queues. Measured
        # on the async subject: 425 of 18,512 requests came back 500 with
        # "Too many connections" at 64 connections against a pool of 8.
        self.redis = redis.Redis(
            connection_pool=redis.BlockingConnectionPool.from_url(
                redis_url, max_connections=POOL_SIZE, decode_responses=True
            )
        )
        # One round trip here, so the connect lands in the startup number where
        # every other subject's also is.
        self.read()

    def read(self):
        cached = self.redis.get(REDIS_KEY)
        with self.pool.connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(SELECT, (ROW_ID,))
                return payload(cached, cursor.fetchone())


class AsyncIo:
    """FastAPI's client: `redis.asyncio` and an async psycopg pool."""

    def __init__(self, pg_url, redis_url):
        import psycopg_pool
        import redis.asyncio

        self.pool = psycopg_pool.AsyncConnectionPool(
            pg_url, min_size=1, max_size=POOL_SIZE, open=False
        )
        # BlockingConnectionPool, for the reason on SyncIo: the default pool
        # errors on exhaustion where every other client in this suite waits.
        self.redis = redis.asyncio.Redis(
            connection_pool=redis.asyncio.BlockingConnectionPool.from_url(
                redis_url, max_connections=POOL_SIZE, decode_responses=True
            )
        )

    async def open(self):
        await self.pool.open(wait=True)
        await self.read()

    async def read(self):
        cached = await self.redis.get(REDIS_KEY)
        async with self.pool.connection() as connection:
            async with connection.cursor() as cursor:
                await cursor.execute(SELECT, (ROW_ID,))
                return payload(cached, await cursor.fetchone())
