import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Module,
  Param,
  Post,
  UsePipes,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import {
  echo,
  jsonPayload,
  type Person,
  personSchema,
  PLAINTEXT,
} from '../shared.js';

/**
 * The NestJS subject, shared by the Express and Fastify adapters — the only thing
 * that differs between them is which platform `NestFactory` is handed, which is
 * the whole point of having both.
 *
 * **This directory is the one place in the repo that uses `experimentalDecorators`
 * and `emitDecoratorMetadata`**, via its own `tsconfig.json`. CLAUDE.md bans them,
 * and that ban is about dunx's own design: dunx uses TC39 standard decorators and
 * has no parameter decorators, which is why `@Inject()` does not exist there. A
 * benchmark subject measuring NestJS obviously has to run NestJS's programming
 * model, legacy decorators and all — measuring a fake Nest would measure nothing.
 * Nothing outside `servers/nest/` may use them.
 *
 * `reflect-metadata` is imported by the entrypoints for the same reason.
 */
class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body') return value;
    // `parse`, not `safeParse`: a throw is what Nest's exception layer turns into
    // a 400, which is the path a real app would take.
    return personSchema.parse(value);
  }
}

@Controller()
export class BenchController {
  // Nest answers a bare string as `text/html`; every other subject sends
  // `text/plain`, and the harness rejects a subject whose media type differs
  // because it would not be answering the same request.
  @Get('/plaintext')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  plaintext(): string {
    return PLAINTEXT;
  }

  @Get('/json')
  json(): { message: string } {
    return jsonPayload();
  }

  @Get('/params/:id')
  params(@Param('id') id: string): { id: string } {
    return { id };
  }

  // The same zod schema every other subject validates against, so the `validate`
  // scenario compares frameworks rather than validators.
  // Nest defaults POST to 201; the scenario contract is 200, which the dunx
  // subject also states explicitly. Same response, same status, same bytes.
  @Post('/validate')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe())
  validate(@Body() body: Person): { name: string; age: number } {
    return echo(body);
  }
}

@Module({ controllers: [BenchController] })
export class AppModule {}
