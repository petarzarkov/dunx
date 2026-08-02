# tools/docs mixes Mantine 8 and Mantine 9

**Open. Pre-existing, currently working.**

| package              | resolved  |
| -------------------- | --------- |
| `@mantine/core`      | 8.3.18    |
| `@mantine/hooks`     | 8.3.18    |
| `@mantine/spotlight` | 8.3.18    |
| `@mantine/charts`    | **9.5.0** |

Mixing Mantine majors is unsupported. It appears to work, which is the dangerous
kind of broken: a patch bump on either side can end it.

Found while adding `@mantine/code-highlight`, which `bun add` also resolved at 9
against core 8. That one was pinned to `^8.3.6` immediately and then removed
entirely, because highlighting now happens at generate time. `charts` was already
mismatched and was left alone rather than changed as a side effect of an unrelated
commit.

## Options

- Upgrade everything to Mantine 9, which has its own breaking surface.
- Pin `charts` to `^8`, if 8 has the chart components the benchmarks page needs.

`tools/*` is private and never published, so this is a maintenance risk rather than
a consumer-facing one.
