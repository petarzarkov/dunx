# The 500-line file limit is not enforced

**Open. Small.**

CLAUDE.md's "Do Not" list says "Do not exceed 500 lines per source file", which
reads as a rule. `.oxlintrc.json` has no `max-lines`, so nothing checks it and it is
a review convention.

Found while writing CONTRIBUTING.md, which documents it honestly as a convention
rather than a gate.

Either add the rule and let CI hold the line, or reword CLAUDE.md so it does not
imply enforcement. Adding it is a one-line config change plus whatever files
currently exceed it.
