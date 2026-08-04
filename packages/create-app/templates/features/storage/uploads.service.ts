import { Logger } from '@dunx/core';
import { LocalStorage, Storage } from '@dunx/infra/files';

const REPORT = 'reports/q1.csv';
const ARCHIVE = 'reports/q2.csv';

/**
 * Injects `Storage`, never `LocalStorage` - swapping a disk for a bucket is then
 * one `forRoot` call in storage.module.ts and nothing here changes.
 */
export class Uploads {
  constructor(
    private readonly storage: Storage,
    private readonly logger: Logger,
  ) {}

  async demonstrate(): Promise<void> {
    const { storage, logger } = this;

    // The contract cannot promise a root - narrowing to the backend is how you
    // reach anything backend-specific.
    if (storage instanceof LocalStorage) {
      logger.info(`root ${storage.root} (an OS temp dir, removed on shutdown)`);
    }

    const bytes = await storage.write(REPORT, 'quarter,amount\nQ1,100\n');
    logger.info(`write  ${REPORT} -> ${bytes} bytes`);
    await storage.write(ARCHIVE, 'quarter,amount\nQ2,140\n');

    logger.info(
      `read   ${REPORT} -> ${JSON.stringify(await storage.read(REPORT))}`,
    );

    const stat = await storage.stat(REPORT);
    logger.info(`stat   ${REPORT} -> ${stat.size} bytes, ${stat.type}`);

    // Bun.Glob, as an AsyncIterable so a million objects page rather than
    // accumulate. Order is the filesystem's, hence the sort.
    const keys: string[] = [];
    for await (const entry of storage.list({
      prefix: 'reports',
      glob: '*.csv',
    })) {
      keys.push(entry.key);
    }
    logger.info(`glob   reports/*.csv -> ${JSON.stringify(keys.sort())}`);

    await storage.delete(ARCHIVE);
    logger.info(`delete ${ARCHIVE} -> exists=${await storage.exists(ARCHIVE)}`);

    // Rejected before any syscall, not sanitised into something that "works".
    try {
      await storage.read('../../etc/passwd');
    } catch (error) {
      logger.info(`traversal rejected: ${(error as Error).message}`);
    }

    // Nothing signs bytes on a local disk, so this refuses instead of handing
    // back a URL that cannot work.
    try {
      storage.presign(REPORT);
    } catch (error) {
      logger.info(`presign refused: ${(error as Error).message}`);
    }
  }
}
