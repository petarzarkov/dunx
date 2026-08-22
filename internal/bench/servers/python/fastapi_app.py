"""FastAPI on uvicorn, as a single file.

The second Python subject, and it answers a different question from the Django
one. Django is a batteries-included synchronous framework on WSGI; FastAPI is an
async ASGI framework whose whole selling point is the thing `@dunx/http` also
does - declarative validation from a schema, with types carried through to the
handler. So this row is the closest cross-language comparison in the suite to
what dunx is for, and `validate` is the scenario to read it on.

Validation is pydantic, not hand-written. That is the opposite choice from
`app.py`, and deliberately so: pydantic is not a separate framework bolted on the
way DRF would be, it is how FastAPI is written, and a hand-rolled check here would
measure a FastAPI nobody deploys. It is also the fair pairing - dunx validates
with zod through Standard Schema, Elysia with TypeBox, this with pydantic.

Answers byte-identically to `servers/shared.ts` - the harness rejects a subject
whose bytes differ, which is what keeps the comparison a comparison.
"""

import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, EmailStr, Field, ValidationError

PLAINTEXT = "Hello, World!"

# `docs_url`/`redoc_url`/`openapi_url` off: they mount three extra routes, and a
# router with routes nothing calls is not what the other subjects carry.
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


class Person(BaseModel):
    """The same three rules as the zod schema in `shared.ts`."""

    name: str = Field(min_length=1)
    age: int = Field(ge=0, strict=True)
    email: EmailStr


class Echo(BaseModel):
    name: str
    age: int


@app.get("/plaintext", response_class=PlainTextResponse)
async def plaintext() -> str:
    return PLAINTEXT


# `response_model` is left off every JSON route on purpose. FastAPI would
# otherwise validate the *response* as well, which no other subject does, and
# `JSONResponse` already writes `json.dumps`' compact separators - so these come
# out byte-identical to `shared.ts` without a `separators` override of the kind
# Django's `JsonResponse` needs.
@app.get("/json")
async def json_reply() -> JSONResponse:
    return JSONResponse({"message": PLAINTEXT})


@app.get("/params/{id}")
async def params(id: str) -> JSONResponse:
    return JSONResponse({"id": id})


# The body is read and validated here rather than through a `Person` parameter.
# A declared parameter is the idiomatic form and would be the one to measure, but
# FastAPI answers a rejection with its own 422 and a `detail` array, where every
# other subject answers 400 and `{"error":"Invalid body"}`. The harness compares
# bytes on the success path only, so the difference would not be caught - it would
# just make this the one row with a different error contract. Same pydantic
# validation either way; `model_validate_json` is what the parameter form calls.
@app.post("/validate")
async def validate(request: Request) -> JSONResponse:
    try:
        person = Person.model_validate_json(await request.body())
    except ValidationError:
        return JSONResponse({"error": "Invalid body"}, status_code=400)

    return JSONResponse(Echo(name=person.name, age=person.age).model_dump())


if __name__ == "__main__":
    import uvicorn

    # One worker, no access log, and uvloop/httptools left to whatever is
    # installed - `uvicorn[standard]` is not required, so the pure-asyncio loop
    # is the floor this measures. One worker for the same reason Go and tokio are
    # pinned to one core.
    #
    # `ws="none"` because this suite serves no websockets and no other subject
    # loads a websocket protocol. It is also required in practice: uvicorn's
    # `ws="auto"` imports `websockets` eagerly, and a system copy old enough to
    # lack `ServerProtocol` takes the whole process down at startup with an
    # ImportError that says nothing about this benchmark.
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.environ.get("PORT", "3000")),
        log_level="critical",
        access_log=False,
        workers=1,
        ws="none",
    )
