//! The io scenario's clients for the Axum subject: `tokio-postgres` behind a
//! `deadpool` pool of the size every subject is pinned to, and `redis-rs` on one
//! multiplexed connection.
//!
//! Built only when the harness passes both URLs, so the other four scenarios run
//! a process that has opened no socket and paid no connect in its startup number.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use redis::AsyncCommands;
use serde::Serialize;
use tokio_postgres::NoTls;

const REDIS_KEY: &str = "bench:greeting";
const ROW_ID: i32 = 1;
const POOL_SIZE: usize = 8;
const SELECT: &str = "SELECT id, memo, amount FROM bench_ledger WHERE id = $1";

/// Field order is JSON field order, and the harness compares bytes.
#[derive(Serialize)]
pub struct IoPayload {
    cached: String,
    id: i32,
    memo: String,
    amount: i32,
}

#[derive(Clone)]
pub struct Io {
    pool: Pool,
    redis: redis::aio::MultiplexedConnection,
}

impl Io {
    /// `None` when the harness did not enable the scenario, which is what `main`
    /// branches on before registering the route.
    pub async fn connect() -> Option<Io> {
        let pg_url = std::env::var("BENCH_IO_PG_URL").ok()?;
        let redis_url = std::env::var("BENCH_IO_REDIS_URL").ok()?;

        let pg_config: tokio_postgres::Config = pg_url.parse().expect("pg url");
        let manager = Manager::from_config(
            pg_config,
            NoTls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        let pool = Pool::builder(manager)
            .max_size(POOL_SIZE)
            .build()
            .expect("pg pool");

        let client = redis::Client::open(redis_url).expect("redis url");
        let redis = client
            .get_multiplexed_async_connection()
            .await
            .expect("redis connect");

        let io = Io { pool, redis };
        // Both connect lazily. Doing one round trip here puts the connect in the
        // startup number, where every other subject's also is.
        io.read().await.expect("io warmup");
        Some(io)
    }

    /// The contract: one Redis GET, then one parameterised Postgres SELECT.
    async fn read(&self) -> Result<IoPayload, Box<dyn std::error::Error>> {
        let mut redis = self.redis.clone();
        let cached: String = redis.get(REDIS_KEY).await?;
        let client = self.pool.get().await?;
        let statement = client.prepare_cached(SELECT).await?;
        let row = client.query_one(&statement, &[&ROW_ID]).await?;
        Ok(IoPayload {
            cached,
            id: row.get(0),
            memo: row.get(1),
            amount: row.get(2),
        })
    }
}

pub async fn handler(axum::extract::State(io): axum::extract::State<Io>) -> Response {
    match io.read().await {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}
