import '../otel.fixture.js';
import { JobProcessor } from './processor.js';
import { sandboxedModule } from './tracing.fixture.js';

export default new JobProcessor(sandboxedModule(), { trace: false }).handle;
