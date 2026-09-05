import { describe, expect, it } from 'bun:test';
import { PathTraversalError } from './errors.js';
import { S3Storage, S3StorageOptions } from './s3.js';

// Signing is HMAC over the canonical request, so every assertion below runs
// offline against credentials that were never real.
const FAKE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  bucket: 'invoices',
  region: 'eu-west-1',
} as const;

const storage = (prefix = ''): S3Storage =>
  new S3Storage(new S3StorageOptions(FAKE, prefix));

/** Real credentials in the environment turn the integration block on. */
const liveBucket = Bun.env['DUNX_S3_TEST_BUCKET'];
/**
 * An S3-compatible endpoint, for running the block against MinIO rather than AWS.
 * Its own variable rather than `S3_ENDPOINT`, which `Bun.S3Client` reads for every
 * client that does not set one: exporting that turned the offline `presign` tests
 * below into assertions about MinIO's host, and two of them failed.
 */
const liveEndpoint = Bun.env['DUNX_S3_TEST_ENDPOINT'];

/** See local.test.ts - bun:test's `.rejects` chain is not typed as thenable. */
const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (reason: unknown) => reason,
  );

describe('S3StorageOptions', () => {
  it('keeps the client options verbatim so Bun resolves credentials', () => {
    expect(new S3StorageOptions(FAKE).client).toEqual(FAKE);
  });

  it('defaults to no prefix and no explicit client options', () => {
    const options = new S3StorageOptions();

    expect(options.prefix).toBe('');
    expect(options.client).toEqual({});
  });

  it('normalises the prefix to exactly one trailing slash', () => {
    expect(new S3StorageOptions(FAKE, 'uploads').prefix).toBe('uploads/');
    expect(new S3StorageOptions(FAKE, 'uploads/').prefix).toBe('uploads/');
    expect(new S3StorageOptions(FAKE, '/uploads//2024/').prefix).toBe(
      'uploads/2024/',
    );
  });

  it('refuses a prefix that walks up', () => {
    expect(() => new S3StorageOptions(FAKE, '../escape')).toThrow(
      PathTraversalError,
    );
  });

  it('selects the S3 backend', () => {
    expect(new S3StorageOptions(FAKE).create()).toBeInstanceOf(S3Storage);
  });
});

describe('S3Storage keys', () => {
  it('leaves a plain key alone when no prefix is configured', () => {
    expect(storage().objectKey('invoice.pdf')).toBe('invoice.pdf');
    expect(storage().prefix).toBe('');
  });

  it('prepends the configured prefix', () => {
    expect(storage('tenant-a').objectKey('invoice.pdf')).toBe(
      'tenant-a/invoice.pdf',
    );
    expect(storage('tenant-a').objectKey('2024/invoice.pdf')).toBe(
      'tenant-a/2024/invoice.pdf',
    );
  });

  it('strips leading and duplicated slashes', () => {
    expect(storage('t').objectKey('/a//b.pdf')).toBe('t/a/b.pdf');
  });

  it('refuses a key that would escape the prefix', () => {
    for (const key of ['../secret', '..', 'a/../../b', '..\\..\\b', '']) {
      expect(() => storage('tenant-a').objectKey(key)).toThrow(
        PathTraversalError,
      );
    }
  });

  it('rejects traversal before any request is attempted', async () => {
    // No network is reachable here, so a PathTraversalError rather than a
    // connection failure proves the check runs ahead of the client call.
    const attempts = [
      storage('t').read('../../etc/passwd'),
      storage('t').exists('..'),
      storage('t').delete('..'),
    ];

    for (const attempt of attempts) {
      expect(await rejection(attempt)).toBeInstanceOf(PathTraversalError);
    }
    expect(() => storage('t').presign('../x')).toThrow(PathTraversalError);
  });
});

describe('S3Storage.presign', () => {
  it('signs a URL for the prefixed key', () => {
    const url = new URL(storage('tenant-a').presign('invoice.pdf'));

    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('s3.eu-west-1.amazonaws.com');
    expect(url.pathname).toBe('/invoices/tenant-a/invoice.pdf');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toContain(
      'eu-west-1/s3/aws4_request',
    );
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('passes expiry, method and content type through', () => {
    const url = new URL(
      storage().presign('upload.csv', {
        expiresIn: 120,
        method: 'PUT',
        type: 'text/csv',
      }),
    );

    expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(url.searchParams.get('response-content-type')).toBe('text/csv');
  });

  it('defaults to a one-day GET URL', () => {
    const url = new URL(storage().presign('invoice.pdf'));

    expect(url.searchParams.get('X-Amz-Expires')).toBe('86400');
  });

  it('signs against a custom endpoint, so MinIO and R2 work', () => {
    const minio = new S3Storage(
      new S3StorageOptions(
        { ...FAKE, endpoint: 'http://localhost:9000' },
        'bucketed',
      ),
    );

    const url = new URL(minio.presign('a.txt'));

    expect(url.origin).toBe('http://localhost:9000');
    expect(url.pathname).toBe('/invoices/bucketed/a.txt');
  });

  it('signs virtual-hosted style when asked', () => {
    const vhost = new S3Storage(
      new S3StorageOptions({ ...FAKE, virtualHostedStyle: true }),
    );

    expect(new URL(vhost.presign('a.txt')).host).toBe(
      'invoices.s3.eu-west-1.amazonaws.com',
    );
  });

  it('produces a different signature per key', () => {
    const one = new URL(storage().presign('a.txt')).searchParams.get(
      'X-Amz-Signature',
    );
    const two = new URL(storage().presign('b.txt')).searchParams.get(
      'X-Amz-Signature',
    );

    expect(one).not.toBe(two);
  });
});

describe.skipIf(liveBucket === undefined)(
  'S3Storage against a real bucket',
  () => {
    // Never reached when the variable is unset - skipIf has already taken the block
    // out - but the fallback keeps `bucket` a plain string for the typechecker.
    const live = (): S3Storage =>
      new S3Storage(
        new S3StorageOptions(
          {
            bucket: liveBucket ?? '',
            ...(liveEndpoint === undefined ? {} : { endpoint: liveEndpoint }),
          },
          'dunx-files-test',
        ),
      );
    const key = `${crypto.randomUUID()}.txt`;

    it('round-trips an object', async () => {
      const storageUnderTest = live();
      await storageUnderTest.write(key, 'hello from dunx');

      expect(await storageUnderTest.read(key)).toBe('hello from dunx');
      expect(await storageUnderTest.exists(key)).toBe(true);

      const stat = await storageUnderTest.stat(key);
      expect(stat.size).toBe(15);
      expect(stat.etag).toBeString();

      const keys: string[] = [];
      for await (const entry of storageUnderTest.list()) keys.push(entry.key);
      expect(keys).toContain(key);

      await storageUnderTest.delete(key);
      expect(await storageUnderTest.exists(key)).toBe(false);
    });

    // The only test of `pump`. `LocalStorage` shared it until Bun 1.4.1 gave
    // `Bun.write` a stream overload, and its suite was what covered the helper;
    // the upload path it exists for had never been run.
    it('multiparts a ReadableStream through the NetworkSink', async () => {
      const storageUnderTest = live();
      const streamKey = `${crypto.randomUUID()}.bin`;
      const chunk = 'dunx'.repeat(16);
      let remaining = 8;

      const written = await storageUnderTest.write(
        streamKey,
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (remaining === 0) return controller.close();
            remaining -= 1;
            controller.enqueue(new TextEncoder().encode(chunk));
          },
        }),
      );

      expect(written).toBe(chunk.length * 8);
      expect(await storageUnderTest.read(streamKey)).toBe(chunk.repeat(8));
      await storageUnderTest.delete(streamKey);
    });

    // A source that fails part way must end the sink in a failed state, so the
    // multipart upload is aborted rather than committed at whatever it had.
    it('aborts the upload when the source errors', async () => {
      const storageUnderTest = live();
      const streamKey = `${crypto.randomUUID()}.bin`;

      const failing = storageUnderTest.write(
        streamKey,
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'));
          },
          pull(controller) {
            controller.error(new Error('source failed'));
          },
        }),
      );

      expect(failing).rejects.toThrow('source failed');
    });
  },
);
