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
import { RolesGuard } from './auth.guard.js';
import { ReportsService } from './reports.service.js';

const renameReport = {
  params: z.object({ id: z.coerce.number().int() }),
  body: z.object({ title: z.string().min(1) }),
} as const;

const createReport = { body: z.object({ title: z.string().min(1) }) } as const;

// A class-level default, overridden per method below. Nothing is enforced here —
// metadata decides nothing until a guard reads it.
@Roles('admin')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  // The global AuthGuard reads this and skips: no credentials needed.
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
