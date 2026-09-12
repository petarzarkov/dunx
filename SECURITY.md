# Security Policy

## Supported versions

Every published `@dunx/*` package shares one version and releases in lockstep, so
there is one supported line for all ten rather than one per package.

| Version | Supported |
| ------- | --------- |
| 3.4.x   | Yes       |
| < 3.4.0 | No        |

Fixes ship as a new release from `main`. There are no maintenance branches and no
backports: upgrading to the current version is how a fix reaches you.

## Reporting a vulnerability

Report privately through GitHub Security Advisories:

**<https://github.com/petarzarkov/dunx/security/advisories/new>**

Private vulnerability reporting is enabled, so that form works for anyone with a
GitHub account. Do not open an issue, a pull request or a discussion for a
suspected vulnerability: all three are public from the moment you file them.

Include what you have:

- the package and version, such as `@dunx/http@3.4.0`
- the Bun version (`bun --version`)
- the smallest app, test or request sequence that reproduces it
- what an attacker gets: a leaked config value, a bypassed guard, code execution

A reproduction against `examples/minimal` or a `createTestApp` test from
`@dunx/testing` is the fastest thing to act on.

## What to expect

dunx has one maintainer, so these are targets rather than a guarantee:

| Stage                                                                    | Target                             |
| ------------------------------------------------------------------------ | ---------------------------------- |
| Acknowledgement that the report arrived                                  | 7 days                             |
| Assessment: accepted, more information needed, or declined with a reason | 14 days                            |
| Release containing the fix for an accepted report                        | 30 days, or a date agreed with you |

An accepted report is fixed on a private fork of the repository, released to npm,
and disclosed as a GitHub advisory with a CVE. You are credited under whatever
name and handle you ask for, or left out if you would rather. Please hold the
details until the advisory is published.

A declined report gets the reasoning, and the exchange stays private either way.

## Scope

In scope: the ten published workspaces under `packages/` and `tools/`, as
installed from npm.

Out of scope, none of them being published: `internal/` (the docs site, the
benchmark harness, the dashboard bundle sources), `examples/`, `docs/` and
`scripts/`. A finding in one of those is an ordinary issue or pull request.

Dependency reports split by who chose the version:

- **dunx chose it.** The `@arkv/*` packages and `oxc-parser` are direct
  dependencies pinned by dunx. A vulnerable pin is dunx's to bump, so report it
  here.
- **You chose it.** zod, drizzle-orm, better-auth, bullmq, ioredis,
  `swagger-ui-dist` and `@scalar/api-reference` are peer dependencies your own
  install resolves. A flaw in one of those belongs upstream; a flaw in how dunx
  calls it belongs here.

Configuration is not a vulnerability, but a control that fails to hold is:

- `DashboardModule.forRoot()` without an `authorize` function serves every panel
  to anything that can reach the port, and logs a warning at boot saying so. An
  `authorize` that can be bypassed is a vulnerability; omitting it is a
  deployment decision.
- The dashboard redacts config values unless `reveal` names them. A value that
  reaches a response without appearing in `reveal` is a vulnerability.

## Verifying a release

Publishing happens only in `.github/workflows/ci.yml`, over npm trusted publishing
(OIDC) with `--provenance`. No npm token exists to be stolen, and each package's
trusted publisher on npmjs.com is bound to this repository and to that workflow
filename.

Check the attestations in a project that installs dunx:

```bash
bunx npm@11.10.1 audit signatures
```

Every version carries a provenance attestation naming this repository and
workflow, except the first one of each package: 0.1.0 for most, 1.2.0 for
`@dunx/dashboard`, 0.2.14 for `@dunx/mcp`. Those were published by hand, since a
package with no versions on npm has no trusted-publisher page to configure yet.
Any later `@dunx/*` version without an attestation did not come from this
repository, so report it.
