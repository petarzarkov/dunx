# Split the OpenAPI explorer behind a ./ui subpath

**Open. Measured.**

`@dunx/openapi` inlines the Mantine explorer as a committed string, so every
consumer pays for it whether or not they serve the page:

|                 | before the explorer |     after |
| --------------- | ------------------: | --------: |
| `dist/index.js` |            40,948 B | 476,510 B |
| import          |             ~6.1 ms |  ~11.0 ms |
| RSS             |            37.0 MiB |  41.7 MiB |

Cold start is already dunx's weakest number, so ~5 ms of it for a page most
services never open is the wrong default.

## Why it is not done

A `./ui` subpath entry means the bundle only loads when the page is requested. That
needs `splitting` enabled in `scripts/build-package.ts`, which every package
shares and which is the publish path. Changing it deserves its own change with its
own verification rather than riding along with a docs commit.

## Alternative

`preact/compat` was measured by the agent that built the explorer as roughly 170 KB
smaller, at the cost of running Mantine on a shim. It was rejected as an unmeasured
gamble at the time and is still worth a spike if the subpath split does not happen.
