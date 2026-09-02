import { describe, expect, it } from 'bun:test';
import {
  DocumentSource,
  generateDocument,
  type DocumentFragment,
} from './generate.js';

const info = { title: 'T', version: '1' };

const fragment: DocumentFragment = {
  paths: { '/api/auth/session': { get: { summary: 'session' } } },
  tags: [{ name: 'Auth' }],
};

/** W8: a contributor the container resolved, rather than a thunk closing over it. */
class AuthDocs extends DocumentSource {
  constructor(private readonly basePath: string) {
    super();
  }

  override contribute(): DocumentFragment {
    return {
      paths: { [`${this.basePath}/session`]: { get: { summary: 'session' } } },
      tags: [{ name: 'Auth' }],
    };
  }
}

describe('a contributor that is an object with contribute()', () => {
  it('is asked for its fragment', async () => {
    const { document } = await generateDocument([], {
      ...info,
      contribute: [new AuthDocs('/api/auth')],
    });

    expect(document.paths['/api/auth/session']).toBeDefined();
    expect(document.tags).toEqual([{ name: 'Auth' }]);
  });

  it('may answer asynchronously', async () => {
    class Slow extends DocumentSource {
      override async contribute(): Promise<DocumentFragment> {
        await Bun.sleep(1);
        return fragment;
      }
    }

    const { document } = await generateDocument([], {
      ...info,
      contribute: [new Slow()],
    });

    expect(document.paths['/api/auth/session']).toBeDefined();
  });

  it('is skipped with a warning when it throws, like any contributor', async () => {
    class Broken extends DocumentSource {
      override contribute(): DocumentFragment {
        throw new Error('no schema');
      }
    }

    const { document, warnings } = await generateDocument([], {
      ...info,
      contribute: [new Broken(), new AuthDocs('/api/auth')],
    });

    // Best effort: one that cannot answer costs documentation, never the boot.
    expect(warnings.some((line) => line.includes('no schema'))).toBe(true);
    expect(document.paths['/api/auth/session']).toBeDefined();
  });

  it('leaves a plain fragment and a thunk working', async () => {
    const { document } = await generateDocument([], {
      ...info,
      contribute: [
        fragment,
        () => ({ paths: { '/from/thunk': { get: { summary: 'x' } } } }),
      ],
    });

    expect(document.paths['/api/auth/session']).toBeDefined();
    expect(document.paths['/from/thunk']).toBeDefined();
  });

  it('does not mistake an empty fragment for a source', async () => {
    // `{}` is what a contributor with nothing to add returns. Testing for the
    // `contribute` method rather than for absent keys is what keeps it a
    // fragment.
    const { document, warnings } = await generateDocument([], {
      ...info,
      contribute: [{}, fragment],
    });

    expect(warnings).toEqual([]);
    expect(document.paths['/api/auth/session']).toBeDefined();
  });
});
