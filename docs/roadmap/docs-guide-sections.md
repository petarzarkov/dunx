# Group the guide into sections

**Partially done.**

The nav has three groups: Guide, Reference (the repo's own documents) and
Packages. Inside Guide the 17 pages are one flat ordered list.

Nest and Elysia both subdivide. Nest has Overview, Fundamentals, Techniques,
Security, GraphQL, Websockets, Microservices, Standalone, CLI, OpenAPI, Recipes.
That structure is doing real work: it tells a reader which pages they need now and
which they can skip until they have a reason.

## A plausible split for the 17 pages

- **Getting started** - introduction, first steps
- **Fundamentals** - providers, modules, controllers, validation
- **Techniques** - middleware and guards, websockets, openapi, testing
- **Infrastructure** - configuration, logging, database, queues, authentication,
  files and images
- **Going live** - deployment

## How it would work

The numeric filename prefix already carries order. A section could come from the
prefix range, or from a `section:` line the generator reads, or from a small map in
`generate.ts`. The prefix range is the least ceremony and needs no new syntax in
the files: 01-02 getting started, 03-06 fundamentals, and so on. It couples section
membership to numbering, which is a real cost when a page moves.
