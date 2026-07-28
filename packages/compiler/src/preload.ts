import { plugin } from 'bun';
import { depsPlugin } from './plugin.js';

// Side-effect entrypoint for `bunfig.toml`:
//   preload = ["@dunx/compiler/preload"]
//
// Awaited, not fire-and-forget: registration has to finish before the entrypoint
// is loaded, or the first modules through would miss the transform.
await plugin(depsPlugin);
