import { AppFactory } from '@dunx/core';
import {
  PathTraversalError,
  S3Storage,
  S3StorageOptions,
  Storage,
  StorageOptions,
  UnsupportedOperationError,
} from '@dunx/files';
import { AppModule, DATA_ROOT } from './app.module.js';
import { ReportsService } from './reports.service.js';

const log = (message: string): void => console.log(`[dunx] ${message}`);

const app = await AppFactory.create(AppModule);
app.enableShutdownHooks();

const reports = app.get(ReportsService);

log(`storage root ${DATA_ROOT}`);
log(`backend ${app.get(Storage).constructor.name}`);
log(`options ${app.get(StorageOptions).constructor.name}`);

const written = await reports.publish('2024-q1', [
  'region,revenue',
  'emea,120',
  'apac,90',
]);
log(`write reports/2024-q1.csv -> ${written} bytes`);
log(
  `read  reports/2024-q1.csv -> ${JSON.stringify(await reports.read('2024-q1'))}`,
);

const streamed = await reports.publishStream(
  '2024-q2',
  Array.from({ length: 500 }, (_, index) => `row-${index},${index * 3}`),
);
log(`stream reports/2024-q2.csv -> ${streamed} bytes, never buffered whole`);
log(
  `stream back reports/2024-q2.csv -> ${await reports.countLines('2024-q2')} lines`,
);

await reports.publish('2023-q4', ['region,revenue', 'emea,80']);
await reports.publish('archive', ['not a quarter']);

log(`glob *.csv      -> ${JSON.stringify(await reports.catalogue('*.csv'))}`);
log(
  `glob 2024-*.csv -> ${JSON.stringify(await reports.catalogue('2024-*.csv'))}`,
);

const stat = await reports.sizeOf('2024-q1');
log(
  `stat reports/2024-q1.csv -> ${stat.size} bytes, modified ${stat.lastModified?.toISOString()}`,
);

await reports.retire('2023-q4');
log(
  `delete reports/2023-q4.csv -> remaining ${JSON.stringify(await reports.catalogue('*.csv'))}`,
);
await reports.retire('2023-q4');
log('delete again -> no error, delete is idempotent');

// The whole point of resolving keys against a root: a key that arrived from
// outside cannot address the filesystem at large.
try {
  await reports.fetchUntrusted('../../etc/passwd');
  log('TRAVERSAL WAS NOT REJECTED — this is a bug');
  process.exitCode = 1;
} catch (error) {
  if (!(error instanceof PathTraversalError)) throw error;
  log(`traversal rejected -> ${error.message}`);
}

try {
  app.get(Storage).presign('reports/2024-q1.csv');
} catch (error) {
  if (!(error instanceof UnsupportedOperationError)) throw error;
  log(`presign on local -> ${error.message}`);
}

// Same wiring, different options object. Signing needs credentials but never the
// network, so this runs offline when they happen to be set and says so when not.
const bucket = Bun.env['S3_BUCKET'] ?? Bun.env['AWS_BUCKET'];
if (bucket === undefined || Bun.env['AWS_ACCESS_KEY_ID'] === undefined) {
  log(
    's3 backend -> skipping: no S3_BUCKET / AWS_ACCESS_KEY_ID in the environment',
  );
} else {
  const s3 = new S3Storage(new S3StorageOptions({ bucket }, 'reports'));
  log(`s3 key     -> ${s3.objectKey('2024-q1.csv')}`);
  log(`s3 presign -> ${s3.presign('2024-q1.csv', { expiresIn: 60 })}`);
}

await app.shutdown();
await app.closed;
log('shutdown complete');

await Bun.$`rm -rf ${DATA_ROOT}`.quiet();
log(`cleaned up ${DATA_ROOT}`);
