# The docs bundle inlines every guide

**Open. Measured.**

`site.json` is imported into the app bundle, so the landing page downloads all 21
guides plus every package README before it renders.

|                                 | gzipped JS |
| ------------------------------- | ---------: |
| before the guides existed       |  428,609 B |
| with 21 guides, no highlighting |  555,354 B |
| with highlighting               |  585,323 B |

Highlighting is 30 KB of that. **The guides are 127 KB**, and none of them is
needed to render `#/`.

## The fix

Split the model per route so a guide loads when it is opened. Vite code-splits a
dynamic import cleanly, and `tools/docs` is already on Vite for exactly this class
of reason. The generator would write one file per guide instead of one `site.json`,
and the guide route would `import()` its page.

The API reference has the same shape: `PackagePage` needs one package's symbols and
loads all eight.

Nothing about this is blocked. It is a straightforward change nobody has made.
