import { Controller, Get } from '@dunx/http';
import { ApiDoc } from '@dunx/openapi';
import { BuildInfo } from './build-info.service.js';

@ApiDoc({
  tags: ['Wiring'],
  description:
    'The DI primitives underneath everything else: token(), inject() and the three provide() shapes.',
})
@Controller('wiring')
export class WiringController {
  constructor(private readonly build: BuildInfo) {}

  @Get('/')
  describe(): {
    startedAt: string;
    revision: string;
    flags: readonly string[];
  } {
    return this.build.describe();
  }
}
