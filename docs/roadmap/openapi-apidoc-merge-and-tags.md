# Method-level @ApiDoc discards the class-level one, and doc.tags ignores both

**Two bugs, same area. High - together they produce an incoherent document.**

## A method-level @ApiDoc replaces the class-level one wholesale

```ts
@ApiDoc({ tags: ['notes'], description: 'class-level' })
@Controller('notes')
class NotesController {
  @ApiDoc({ summary: 'method-level' }) @Get('/a') a() {}
  @Get('/b') b() {}
}
```

```
/notes/a  {"tags":["Notes"],"summary":"method-level"}     <- class tags and description gone
/notes/b  {"tags":["notes"],"description":"class-level"}
```

The class's `tags` and `description` vanish on the annotated method, and the tag
silently falls back to the class-name default `Notes`.

**Guide 09 shows exactly this shape as the way to tag and describe.** It appears to
work there only because the example chose `tags: ['Notes']`, which happens to equal
the derived default. In NestJS `@ApiTags` on the class and `@ApiOperation` on the
method compose. Class tags plus per-method summaries is the single most common
annotation pattern and it is currently unreachable.

## Top-level doc.tags is derived from class names and ignores @ApiDoc

Same controller: `doc.tags` is `[{name:'Notes'},{name:'OpenApi'}]` while an
operation is tagged `notes`. In the template the document declares
`Audit, Health, OpenApi, Users` while operations reference `audit, service, users` -
declared tags nothing uses, used tags nothing declares. Every viewer's sidebar and
operation list disagree.

## Fix

Merge class-level and method-level `@ApiDoc` per field, method winning on conflict,
and derive `doc.tags` from the tags operations actually carry rather than from class
names. Both pinned in `dunx-template`'s `src/openapi.spec.ts`.
