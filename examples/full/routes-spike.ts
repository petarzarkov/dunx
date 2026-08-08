import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BunAdapter } from '@bull-board/bun';
import { Queue } from 'bullmq';

const queue = new Queue('probe', {
  connection: { url: 'redis://localhost:6379' },
});
const adapter = new BunAdapter();
adapter.setBasePath('/_dunx/queues');
createBullBoard({ queues: [new BullMQAdapter(queue)], serverAdapter: adapter });
for (const [path, handlers] of Object.entries(adapter.getRoutes())) {
  console.log(Object.keys(handlers).join(','), path);
}
process.exit(0);
