import { Storage, type ListEntry } from '@dunx/files';

/**
 * Constructor injection with no annotations. `Storage` is an abstract class, so
 * `@dunx/compiler` can record it as this class's dependency — and nothing here
 * knows whether it is talking to a disk or to a bucket.
 */
export class ReportsService {
  constructor(private readonly storage: Storage) {}

  async publish(quarter: string, rows: readonly string[]): Promise<number> {
    return this.storage.write(`reports/${quarter}.csv`, rows.join('\n'));
  }

  /** Streams in, so a report larger than memory still uploads. */
  async publishStream(
    quarter: string,
    rows: readonly string[],
  ): Promise<number> {
    const encoder = new TextEncoder();
    const queue = rows.map((row) => `${row}\n`);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const row = queue.shift();
        if (row === undefined) controller.close();
        else controller.enqueue(encoder.encode(row));
      },
    });

    return this.storage.write(`reports/${quarter}.csv`, body);
  }

  async read(quarter: string): Promise<string> {
    return this.storage.read(`reports/${quarter}.csv`);
  }

  /** Reads back a chunk at a time rather than materialising the whole object. */
  async countLines(quarter: string): Promise<number> {
    const stream = await this.storage.readStream(`reports/${quarter}.csv`);
    const decoder = new TextDecoder();
    let lines = 0;
    let chunks = 0;

    for await (const chunk of stream) {
      chunks += 1;
      for (const character of decoder.decode(chunk, { stream: true })) {
        if (character === '\n') lines += 1;
      }
    }

    return chunks === 0 ? 0 : lines;
  }

  async catalogue(glob: string): Promise<readonly string[]> {
    const keys: string[] = [];
    for await (const entry of this.storage.list({ prefix: 'reports', glob })) {
      keys.push(entry.key);
    }
    return keys.sort();
  }

  async sizeOf(quarter: string): Promise<ListEntry> {
    const stat = await this.storage.stat(`reports/${quarter}.csv`);
    return { key: stat.key, size: stat.size, lastModified: stat.lastModified };
  }

  async retire(quarter: string): Promise<void> {
    await this.storage.delete(`reports/${quarter}.csv`);
  }

  /** Whatever the caller sends, it cannot address anything outside the root. */
  async fetchUntrusted(key: string): Promise<string> {
    return this.storage.read(key);
  }
}
