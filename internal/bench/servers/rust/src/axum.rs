//! Axum on tokio, built with `cargo build --release` and no profile tuning, so
//! this is what `cargo` gives anyone out of the box rather than a benchmark build.
//!
//! The runtime is `current_thread` on purpose: every other subject in this suite
//! is single-threaded, and a 32-core tokio server measured against a
//! single-threaded JavaScript one is not a framework comparison. See the README,
//! "Threads".

use axum::extract::rejection::JsonRejection;
use axum::extract::Path;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::serve::ListenerExt;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use validator::Validate;

const PLAINTEXT: &str = "Hello, World!";

#[derive(Serialize)]
struct Message {
    message: &'static str,
}

#[derive(Serialize)]
struct Param {
    id: String,
}

/// The same rules as the zod schema in servers/shared.ts. The email regex is the
/// `validator` crate's, not zod's, which is the one place the schemas differ.
#[derive(Deserialize, Validate)]
struct Person {
    #[validate(length(min = 1))]
    name: String,
    #[validate(range(min = 0))]
    age: i64,
    #[validate(email)]
    email: String,
}

#[derive(Serialize)]
struct Echo {
    name: String,
    age: i64,
}

#[derive(Serialize)]
struct Invalid {
    error: &'static str,
}

async fn plaintext() -> &'static str {
    PLAINTEXT
}

async fn json() -> Json<Message> {
    Json(Message {
        message: PLAINTEXT,
    })
}

async fn params(Path(id): Path<String>) -> Json<Param> {
    Json(Param { id })
}

fn invalid() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(Invalid {
            error: "Invalid body",
        }),
    )
        .into_response()
}

async fn validate(body: Result<Json<Person>, JsonRejection>) -> Response {
    let Ok(Json(person)) = body else {
        return invalid();
    };
    if person.validate().is_err() {
        return invalid();
    }
    Json(Echo {
        name: person.name,
        age: person.age,
    })
    .into_response()
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let app = Router::new()
        .route("/plaintext", get(plaintext))
        .route("/json", get(json))
        .route("/params/{id}", get(params))
        .route("/validate", post(validate));

    let port = std::env::var("PORT").unwrap_or_else(|_| "0".to_owned());
    // `axum::serve` leaves Nagle on, and Go's net/http and Bun's uSockets both
    // set TCP_NODELAY on every accepted connection. Leaving it off would
    // handicap Axum with a socket option and call it a framework difference.
    // Measured over six interleaved rounds it makes no difference this harness
    // can resolve; it stays because the subjects it is compared with do it.
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .expect("bind")
        .tap_io(|stream| {
            let _ = stream.set_nodelay(true);
        });
    axum::serve(listener, app).await.expect("serve");
}
