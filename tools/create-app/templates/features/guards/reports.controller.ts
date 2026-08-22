import {
  Controller,
  Get,
  Patch,
  Post,
  Public,
  Roles,
  UseGuards,
  type Input,
} from '@dunx/http';
import { z } from 'zod';
import { AuthGuard, RolesGuard } from './auth.guard.js';
import { ReportsService } from './reports.service.js';

const CreateReport = z
  .object({ title: z.string().min(1) })
  .meta({ id: 'CreateReport', description: 'A report to file' });

const RenameReport = z.object({ title: z.string().min(1) }).meta({
  id: 'RenameReport',
  description: 'A new title for an existing report',
});

const renameReport = {
  params: z.object({ id: z.coerce.number().int() }),
  body: RenameReport,
} as const;

const createReport = { body: CreateReport } as const;

// `@UseGuards(AuthGuard)` at class scope rather than as global middleware: every
// other route in this app is meant to be reachable without credentials, and a
// global guard would challenge all of them. `@Roles('admin')` is a class-level
// default overridden per method below - metadata decides nothing until a guard
// reads it.
@Roles('admin')
@UseGuards(AuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  // The class-level AuthGuard reads this and skips: no credentials needed.
  @Public()
  @Get('/health')
  health(): { ok: true } {
    return { ok: true };
  }

  // Authenticated, but no RolesGuard reads the class-level @Roles here.
  @Get('/')
  list(): readonly string[] {
    return this.reports.titles();
  }

  // Method-scoped guard, reading the class-level @Roles('admin').
  @UseGuards(RolesGuard)
  @Post('/', createReport)
  create(input: Input<typeof createReport>): readonly string[] {
    return this.reports.add(input.body.title);
  }

  // A method-level @Roles wins over the class-level one.
  @Roles('editor')
  @UseGuards(RolesGuard)
  @Patch('/:id', renameReport)
  rename(input: Input<typeof renameReport>): readonly string[] {
    return this.reports.rename(input.params.id, input.body.title);
  }
}
