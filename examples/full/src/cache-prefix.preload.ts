// One L2 namespace per process, so two suites against the one valkey this repo
// runs do not read each other's entries. `cache.module.ts` reads the variable;
// an app that sets none gets a stable prefix, which is what a shared L2 needs.
process.env['DUNX_CACHE_PREFIX'] ??= `dunx-full:${process.pid}`;
