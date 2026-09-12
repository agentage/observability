import { describe, it, expect, vi, afterEach } from 'vitest';
import { installFetchPatch, wrapFetch } from '../../src/internal/patch/fetch.js';
import { tracedFetch } from '../../src/traced-fetch.js';
import { errorFrameFields } from '../../src/internal/error-fields.js';

// The wrap installed on the global by the bootstrap, over a stub `fetch`.
const patched = (inner: typeof fetch): typeof fetch => wrapFetch(inner);

const rejecting = (err: unknown): typeof fetch =>
  patched(() => Promise.reject(err) as ReturnType<typeof fetch>);

// `fetchTargetOf` is module-private: the target is observable as the
// `fetchTarget` stamped on a rejection, which is what the log line lifts.
const targetOfCall = async (...args: Parameters<typeof fetch>): Promise<unknown> => {
  const thrown = await rejecting(new TypeError('fetch failed'))(...args).catch(
    (err: unknown) => err
  );
  return (thrown as { fetchTarget?: string }).fetchTarget;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetch patch', () => {
  it('passes the response through untouched', async () => {
    const response = { ok: true } as Response;
    const inner = vi.fn(() => Promise.resolve(response));
    await expect(
      patched(inner as unknown as typeof fetch)('https://example.test/x', {
        method: 'POST',
      })
    ).resolves.toBe(response);
    expect(inner).toHaveBeenCalledWith('https://example.test/x', { method: 'POST' });
  });

  it('formats a call-site stack only when the fetch rejects', async () => {
    // prepareStackTrace runs exactly when a stack is formatted, so it counts the
    // work the success path must not do.
    const original = Error.prepareStackTrace;
    const formatted: string[] = [];
    Error.prepareStackTrace = (err, frames) => {
      formatted.push(err.message);
      return frames.map((frame) => `    at ${String(frame)}`).join('\n');
    };
    try {
      await patched((() => Promise.resolve({ ok: true })) as unknown as typeof fetch)(
        'https://example.test/ok'
      );
      expect(formatted).not.toContain('fetch call site');
      await rejecting(new TypeError('fetch failed'))('https://example.test/bad').catch(() => {});
      expect(formatted).toContain('fetch call site');
    } finally {
      Error.prepareStackTrace = original;
    }
  });

  it('keeps the awaiting caller in the captured call site', async () => {
    const call = rejecting(new TypeError('fetch failed'));
    const namedOutboundCaller = async (): Promise<unknown> => await call('https://example.test/x');
    const thrown = await namedOutboundCaller().catch((err: unknown) => err);
    expect((thrown as { callSite?: string }).callSite).toContain('namedOutboundCaller');
  });

  it('attaches a non-enumerable callSite stack on rejection and rethrows', async () => {
    const failure = new TypeError('fetch failed');
    failure.stack = 'TypeError: fetch failed\n    at fetch (node:internal/deps/undici:1:1)';
    const thrown = await rejecting(failure)('https://example.test/x').catch((err: unknown) => err);
    expect(thrown).toBe(failure);
    expect(typeof (thrown as { callSite?: string }).callSite).toBe('string');
    expect(Object.keys(failure)).not.toContain('callSite');
    // The captured stack is what gives the frame extractor an application frame.
    expect(errorFrameFields(failure).frame).toContain('fetch-patch.test');
  });

  it('leaves a non-Error rejection alone', async () => {
    await expect(rejecting('nope')('https://example.test/x')).rejects.toBe('nope');
  });

  it('attaches a non-enumerable fetchTarget on rejection', async () => {
    const failure = new TypeError('fetch failed');
    const thrown = await rejecting(failure)('https://api.test/v1/memories/42', {
      method: 'delete',
    }).catch((err: unknown) => err);
    expect((thrown as { fetchTarget?: string }).fetchTarget).toBe(
      'DELETE api.test/v1/memories/:id'
    );
    expect(Object.keys(failure)).not.toContain('fetchTarget');
  });

  it('keeps a fetchTarget an outer wrapper already set', async () => {
    const failure = new TypeError('fetch failed');
    Object.defineProperty(failure, 'fetchTarget', { value: 'GET first.test/', configurable: true });
    const thrown = await rejecting(failure)('https://second.test/x').catch((err: unknown) => err);
    expect((thrown as { fetchTarget?: string }).fetchTarget).toBe('GET first.test/');
  });

  it('finds the target through a wrapping cause chain', async () => {
    const failure = new TypeError('fetch failed');
    const thrown = await rejecting(failure)('https://api.test/v1/ping').catch(
      (err: unknown) => err
    );
    const wrapped = new Error('provisioning failed', {
      cause: new Error('inner', { cause: thrown }),
    });
    expect(errorFrameFields(wrapped).target).toBe('GET api.test/v1/ping');
  });

  it('has no target when nothing in the chain carries one', () => {
    expect(errorFrameFields(new Error('plain')).target).toBeUndefined();
    expect(errorFrameFields('not an error').target).toBeUndefined();
  });
});

describe('installFetchPatch', () => {
  const restore = (original: typeof fetch): void => {
    globalThis.fetch = original;
  };

  it('wraps the global fetch once and enriches its rejections', async () => {
    const original = globalThis.fetch;
    try {
      const failure = new TypeError('fetch failed');
      globalThis.fetch = (() => Promise.reject(failure)) as unknown as typeof fetch;
      expect(installFetchPatch({} as NodeJS.ProcessEnv)).toBe(true);
      const wrapped = globalThis.fetch;
      // Second install is a no-op: a wrapped wrapper would double every stack.
      expect(installFetchPatch({} as NodeJS.ProcessEnv)).toBe(false);
      expect(globalThis.fetch).toBe(wrapped);
      const thrown = await globalThis
        .fetch('https://api.test/v1/ping')
        .catch((err: unknown) => err);
      expect((thrown as { fetchTarget?: string }).fetchTarget).toBe('GET api.test/v1/ping');
    } finally {
      restore(original);
    }
  });

  it('installs nothing when OBS_FETCH_PATCH is off', () => {
    const original = globalThis.fetch;
    try {
      expect(installFetchPatch({ OBS_FETCH_PATCH: 'off' } as NodeJS.ProcessEnv)).toBe(false);
      expect(globalThis.fetch).toBe(original);
    } finally {
      restore(original);
    }
  });
});

describe('tracedFetch', () => {
  it('is now plain fetch - the enrichment lives on the global', async () => {
    const response = { ok: true } as Response;
    const stub = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    await expect(tracedFetch('https://example.test/x', { method: 'POST' })).resolves.toBe(response);
    expect(stub).toHaveBeenCalledWith('https://example.test/x', { method: 'POST' });
  });
});

describe('fetchTarget stamping', () => {
  it('defaults the method to GET and templates nothing on a bare root', async () => {
    await expect(targetOfCall('https://api.test/')).resolves.toBe('GET api.test/');
  });

  it('templates uuid, long hex and all-digit segments', async () => {
    await expect(
      targetOfCall('https://api.test/v1/u/123e4567-e89b-12d3-a456-426614174000/notes')
    ).resolves.toBe('GET api.test/v1/u/:id/notes');
    await expect(targetOfCall('https://api.test/blobs/5f2b8c1d9e4a7b3c6d8e')).resolves.toBe(
      'GET api.test/blobs/:id'
    );
    await expect(targetOfCall('https://api.test/users/98765')).resolves.toBe(
      'GET api.test/users/:id'
    );
  });

  it('drops the query string and hash', async () => {
    await expect(targetOfCall('https://api.test/search?q=secret&page=2#frag')).resolves.toBe(
      'GET api.test/search'
    );
  });

  it('keeps a non-default port', async () => {
    await expect(targetOfCall('https://api.test:8443/v1/ping')).resolves.toBe(
      'GET api.test:8443/v1/ping'
    );
  });

  it('never leaks credentials from the authority', async () => {
    const target = await targetOfCall('https://user:hunter2@api.test/v1/ping');
    expect(target).toBe('GET api.test/v1/ping');
    expect(target).not.toContain('hunter2');
  });

  it('reads method and url off a Request input', async () => {
    const request = new Request('https://api.test/v1/items/7', { method: 'put' });
    await expect(targetOfCall(request)).resolves.toBe('PUT api.test/v1/items/:id');
  });

  it('lets an explicit init method win over the Request method', async () => {
    const request = new Request('https://api.test/v1/ping', { method: 'POST' });
    await expect(targetOfCall(request, { method: 'head' })).resolves.toBe('HEAD api.test/v1/ping');
  });
});
