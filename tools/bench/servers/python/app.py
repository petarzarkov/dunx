"""Django, as a single-file project.

Elysia's landing page benchmarks against Django, so this is here to answer the same
question the Go, Rust and JVM subjects answer: how far from a mature
batteries-included framework in another language is a Bun one?

Single file on purpose. `django-admin startproject` writes eight, and seven of them
would be settings this benchmark disables. What is left is the routing, the
validation and the four responses, which is what the suite compares.

Answers byte-identically to `servers/shared.ts` - the harness rejects a subject
whose bytes differ, which is what keeps the comparison a comparison.
"""

import json
import os

from django.conf import settings
from django.core.handlers.wsgi import WSGIHandler
from django.http import HttpResponse, JsonResponse
from django.urls import path

PLAINTEXT = "Hello, World!"

# Everything a request does not need is off. DEBUG in particular: it installs
# exception middleware and keeps a query log, and leaving it on would measure
# Django's debug tooling rather than Django.
settings.configure(
    DEBUG=False,
    ALLOWED_HOSTS=["*"],
    SECRET_KEY="bench-only-not-a-secret",
    ROOT_URLCONF=__name__,
    # No sessions, no auth, no messages, no CSRF. A benchmark that leaves the
    # default stack on is measuring middleware the other subjects do not have.
    MIDDLEWARE=[],
    INSTALLED_APPS=[],
    USE_TZ=False,
    DEFAULT_CHARSET="utf-8",
)


def plaintext(_request):
    return HttpResponse(PLAINTEXT, content_type="text/plain;charset=utf-8")


# `JsonResponse` defaults to `json.dumps`' `", "` and `": "` separators, so it
# writes `{"message": "Hello, World!"}` where every other subject writes
# `{"message":"Hello, World!"}`. The harness compares bytes and would reject the
# subject outright, which is the check doing its job.
COMPACT = {"separators": (",", ":")}


def json_reply(_request):
    return JsonResponse({"message": PLAINTEXT}, json_dumps_params=COMPACT)


def params(_request, id):
    return JsonResponse({"id": id}, json_dumps_params=COMPACT)


def validate(request):
    """The same three rules as the zod schema in `shared.ts`.

    Hand-written rather than a serializer: DRF is a separate framework and would
    make this a DRF measurement. Django itself has forms, but a form validates
    form-encoded input and this endpoint takes JSON, so the check is explicit.
    """
    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse(
            {"error": "Invalid body"}, status=400, json_dumps_params=COMPACT
        )

    if not isinstance(body, dict):
        return JsonResponse(
            {"error": "Invalid body"}, status=400, json_dumps_params=COMPACT
        )

    name = body.get("name")
    age = body.get("age")
    email = body.get("email")

    if not isinstance(name, str) or len(name) < 1:
        return JsonResponse(
            {"error": "Invalid body"}, status=400, json_dumps_params=COMPACT
        )
    # bool is a subclass of int in Python, so True would otherwise pass as an age.
    if not isinstance(age, int) or isinstance(age, bool) or age < 0:
        return JsonResponse(
            {"error": "Invalid body"}, status=400, json_dumps_params=COMPACT
        )
    if not isinstance(email, str) or "@" not in email or "." not in email:
        return JsonResponse(
            {"error": "Invalid body"}, status=400, json_dumps_params=COMPACT
        )

    return JsonResponse({"name": name, "age": age}, json_dumps_params=COMPACT)


urlpatterns = [
    path("plaintext", plaintext),
    path("json", json_reply),
    path("params/<str:id>", params),
    path("validate", validate),
]

application = WSGIHandler()


if __name__ == "__main__":
    # gunicorn, one worker, one thread.
    #
    # Not `wsgiref.simple_server`, and not `runserver`. `wsgiref` is the standard
    # library's *reference* implementation: it serialises connections, so at the
    # 64 the harness opens it measured **317 req/s with a p99 of 1.27 s and 32
    # dropped connections** - a number about `wsgiref`, not about Django, and one
    # that would have made this row a lie by a factor of a hundred. `runserver` is
    # a development server that reloads and logs every request.
    #
    # gunicorn is what a Django deployment actually uses. One worker because every
    # other subject here is pinned to one core; a real deployment runs several, and
    # the README says so on this row.
    from gunicorn.app.base import BaseApplication

    class Bench(BaseApplication):
        def load_config(self):
            port = os.environ.get("PORT", "3000")
            self.cfg.set("bind", f"127.0.0.1:{port}")
            self.cfg.set("workers", 1)
            self.cfg.set("accesslog", None)
            self.cfg.set("errorlog", None)

        def load(self):
            return application

    Bench().run()
