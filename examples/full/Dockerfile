# The live demo at demo.dunx.win: this example, unmodified, behind a Cloudflare
# tunnel. Build context is the **workspace root**, not this directory:
#
#   docker build -f examples/full/Dockerfile -t dunx-demo .
#
# ## It runs from source, and that is not laziness
#
# `bun src/main.ts` is the shape dunx documents for deployment. Bun transpiles on
# the fly and `@dunx/transform/preload` records each class's constructor
# parameter types at load time, which makes `@dunx/transform` a **runtime**
# dependency and `examples/full/bunfig.toml` load-bearing in the image. Bun reads
# bunfig.toml from the process cwd and does not walk up, so the final WORKDIR is
# this example rather than /app.
#
# The bullmq fork that runs a `background` handler inherits that cwd, which is
# what keeps the thumbnail queue working.

# ---- build: install the workspace and emit each package's dist -------------
FROM oven/bun:1.4.2-slim AS build
WORKDIR /app

# The whole workspace. A `--frozen-lockfile` install reads every workspace named
# in bun.lock and refuses a checkout where one is missing, so pruning to the
# example's own transitive set is not worth the breakage.
COPY . .
RUN bun install --frozen-lockfile

# `bun run build` would also build the documentation site and compile
# `examples/binary` into a 77 MB standalone binary, neither of which this image
# serves. So the packages are built directly - but **in this order**, and the
# order is the point: every inter-package edge here is a `peerDependency` and no
# package lists another in `dependencies`. `bun run --filter '*'` orders by
# `dependencies` alone, which leaves it free to run `@dunx/http`'s
# `tsc --emitDeclarationOnly` before `@dunx/core` has emitted the types it reads.
# `scripts/build-all.ts` exists for exactly that reason; this is its ordering for
# the seven packages the example imports.
RUN bun run --filter '@dunx/core' build \
  && bun run --filter '@dunx/transform' build \
  && bun run --filter '@dunx/http' build \
  && bun run --filter '@dunx/infra' build \
  && bun run --filter '@dunx/openapi' build \
  && bun run --filter '@dunx/auth' build \
  && bun run --filter '@dunx/dashboard' build

# ---- runtime ---------------------------------------------------------------
FROM oven/bun:1.4.2-slim AS runtime
WORKDIR /app

# curl for the healthcheck below, and nothing else.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

# `DATABASE_FILE` stays `:memory:`, the schema's default: the demo reseeds on
# every restart, so nothing a visitor creates outlives the process and no
# personal data reaches a disk. `AUTH_SECRET` has no default worth shipping and
# is passed by the compose file.
ENV NODE_ENV=production \
    TZ=UTC \
    PORT=3000 \
    LOG_FORMAT=json \
    LOG_REQUEST_BODY=false \
    LOG_RESPONSE_BODY=false \
    DATABASE_FILE=:memory: \
    DASHBOARD_COMMANDS=false \
    TRUST_PROXY=true

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/bunfig.toml /app/tsconfig.json ./
# src as well as dist: Bun resolves each package through its `exports` map, which
# points at dist, and the sourcemaps in dist name these files.
COPY --from=build /app/packages ./packages
COPY --from=build /app/examples/full ./examples/full

USER bun
EXPOSE 3000

# Readiness rather than liveness. It probes the database, and a liveness probe
# that fails on a dependency restarts the process when that dependency blinks.
# Redis reports `down` without gating readiness, so an absent broker degrades the
# cache panel instead of looping the container.
HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health/ready" || exit 1

WORKDIR /app/examples/full
CMD ["bun", "src/main.ts"]
