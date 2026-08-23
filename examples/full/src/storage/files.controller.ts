import {
  Controller,
  Delete,
  Get,
  HttpError,
  HttpStatusCode,
  Put,
  type Input,
} from '@dunx/http';
import { LocalStorage, PathTraversalError, Storage } from '@dunx/infra/files';
import { z } from 'zod';

/**
 * The key is a query parameter because keys contain slashes: `reports/q1.csv` is
 * one key, not two segments. `Storage` itself rejects traversal - try
 * `?key=../../etc/passwd`.
 */
const FileKey = z.object({ key: z.string().min(1).max(200) }).meta({
  id: 'FileKey',
  description: 'An object key inside the storage root',
});

const WriteFile = z
  .object({ content: z.string().max(64 * 1024) })
  .meta({ id: 'WriteFile', description: 'Text to store under the key' });

const listFiles = {
  query: z.object({
    prefix: z.string().default(''),
    glob: z.string().default('**/*'),
  }),
} as const;
const objectKey = { query: FileKey } as const;
const writeFile = { query: FileKey, body: WriteFile } as const;

/** Injects `Storage`, never `LocalStorage`: swapping disk for bucket is one
 * `forRoot` call and nothing here changes. */
@Controller('files')
export class FilesController {
  constructor(private readonly storage: Storage) {}

  @Get('/', listFiles)
  async list(
    input: Input<typeof listFiles>,
  ): Promise<{ root: string; keys: readonly string[] }> {
    const keys: string[] = [];
    for await (const entry of this.storage.list({
      prefix: input.query.prefix,
      glob: input.query.glob,
    })) {
      keys.push(entry.key);
    }
    // The contract cannot promise a root, so narrowing reaches it.
    const root =
      this.storage instanceof LocalStorage ? this.storage.root : '(remote)';
    return { root, keys: keys.sort() };
  }

  @Get('/object', objectKey)
  async read(
    input: Input<typeof objectKey>,
  ): Promise<{ key: string; size: number; type: string; content: string }> {
    const { key } = input.query;
    await this.present(key);
    const stat = await this.storage.stat(key);
    return {
      key,
      size: stat.size,
      type: stat.type,
      content: await this.storage.read(key),
    };
  }

  @Put('/object', writeFile)
  async write(
    input: Input<typeof writeFile>,
  ): Promise<{ key: string; bytes: number }> {
    const { key } = input.query;
    try {
      return { key, bytes: await this.storage.write(key, input.body.content) };
    } catch (error) {
      if (!(error instanceof PathTraversalError)) throw error;
      throw new HttpError(HttpStatusCode.BAD_REQUEST, error.message);
    }
  }

  @Delete('/object', objectKey)
  async remove(input: Input<typeof objectKey>): Promise<{ deleted: boolean }> {
    const { key } = input.query;
    await this.present(key);
    await this.storage.delete(key);
    return { deleted: true };
  }

  /** Nothing signs bytes on a local disk, so this refuses rather than hand back
   * a URL that cannot work. */
  @Get('/presign', objectKey)
  async presign(input: Input<typeof objectKey>): Promise<{ url: string }> {
    const { key } = input.query;
    await this.present(key);
    try {
      return { url: this.storage.presign(key) };
    } catch (error) {
      throw new HttpError(
        HttpStatusCode.NOT_IMPLEMENTED,
        (error as Error).message,
      );
    }
  }

  /** A traversal is a bad request: `Storage` rejects it before any syscall, and
   * without this it would surface as a 500. */
  private async present(key: string): Promise<void> {
    try {
      if (await this.storage.exists(key)) return;
    } catch (error) {
      if (!(error instanceof PathTraversalError)) throw error;
      throw new HttpError(HttpStatusCode.BAD_REQUEST, error.message);
    }
    throw new HttpError(HttpStatusCode.NOT_FOUND, `No object "${key}"`);
  }
}
