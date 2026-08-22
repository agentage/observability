import { describe, it, expect, vi, afterEach } from 'vitest';
import { tracedFetch, fetchTargetOf } from '../src/traced-fetch.js';
import { frameOf, targetOf } from '../src/error-frame.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tracedFetch', () => {
  it('passes the response through untouched', async () => {
    const response = { ok: true } as Response;
    const stub = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    await expect(tracedFetch('https://example.test/x', { method: 'POST' })).resolves.toBe(response);
    expect(stub).toHaveBeenCalledWith('https://example.test/x', { method: 'POST' });
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
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
      await tracedFetch('https://example.test/ok');
      expect(formatted).not.toContain('fetch call site');
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
      await tracedFetch('https://example.test/bad').catch(() => {});
      expect(formatted).toContain('fetch call site');
    } finally {
      Error.prepareStackTrace = original;
    }
  });

  it('keeps the awaiting caller in the captured call site', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const namedOutboundCaller = async (): Promise<unknown> =>
      await tracedFetch('https://example.test/x');
    const thrown = await namedOutboundCaller().catch((err: unknown) => err);
    expect((thrown as { callSite?: string }).callSite).toContain('namedOutboundCaller');
  });

  it('attaches a non-enumerable callSite stack on rejection and rethrows', async () => {
    const failure = new TypeError('fetch failed');
    failure.stack = 'TypeError: fetch failed\n    at fetch (node:internal/deps/undici:1:1)';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
    const thrown = await tracedFetch('https://example.test/x').catch((err: unknown) => err);
    expect(thrown).toBe(failure);
    const callSite = (thrown as { callSite?: string }).callSite;
    expect(typeof callSite).toBe('string');
    expect(Object.keys(failure)).not.toContain('callSite');
    // The captured stack is what gives the frame extractor an application frame.
    expect(frameOf(failure)).toContain('traced-fetch');
  });

  it('leaves a non-Error rejection alone', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue('nope');
    await expect(tracedFetch('https://example.test/x')).rejects.toBe('nope');
  });

  it('attaches a non-enumerable fetchTarget on rejection', async () => {
    const failure = new TypeError('fetch failed');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
    const thrown = await tracedFetch('https://api.test/v1/memories/42', { method: 'delete' }).catch(
      (err: unknown) => err
    );
    expect((thrown as { fetchTarget?: string }).fetchTarget).toBe(
      'DELETE api.test/v1/memories/:id'
    );
    expect(Object.keys(failure)).not.toContain('fetchTarget');
  });

  it('keeps a fetchTarget an outer wrapper already set', async () => {
    const failure = new TypeError('fetch failed');
    Object.defineProperty(failure, 'fetchTarget', { value: 'GET first.test/', configurable: true });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
    const thrown = await tracedFetch('https://second.test/x').catch((err: unknown) => err);
    expect((thrown as { fetchTarget?: string }).fetchTarget).toBe('GET first.test/');
  });

  it('finds the target through a wrapping cause chain', async () => {
    const failure = new TypeError('fetch failed');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
    const thrown = await tracedFetch('https://api.test/v1/ping').catch((err: unknown) => err);
    const wrapped = new Error('provisioning failed', {
      cause: new Error('inner', { cause: thrown }),
    });
    expect(targetOf(wrapped)).toBe('GET api.test/v1/ping');
  });

  it('has no target when nothing in the chain carries one', () => {
    expect(targetOf(new Error('plain'))).toBeUndefined();
    expect(targetOf('not an error')).toBeUndefined();
  });
});

describe('fetchTargetOf', () => {
  it('defaults the method to GET and templates nothing on a bare root', () => {
    expect(fetchTargetOf('https://api.test/')).toBe('GET api.test/');
  });

  it('templates uuid, long hex and all-digit segments', () => {
    expect(fetchTargetOf('https://api.test/v1/u/123e4567-e89b-12d3-a456-426614174000/notes')).toBe(
      'GET api.test/v1/u/:id/notes'
    );
    expect(fetchTargetOf('https://api.test/blobs/5f2b8c1d9e4a7b3c6d8e')).toBe(
      'GET api.test/blobs/:id'
    );
    expect(fetchTargetOf('https://api.test/users/98765')).toBe('GET api.test/users/:id');
  });

  it('drops the query string and hash', () => {
    expect(fetchTargetOf('https://api.test/search?q=secret&page=2#frag')).toBe(
      'GET api.test/search'
    );
  });

  it('keeps a non-default port', () => {
    expect(fetchTargetOf('https://api.test:8443/v1/ping')).toBe('GET api.test:8443/v1/ping');
  });

  it('never leaks credentials from the authority', () => {
    const target = fetchTargetOf('https://user:hunter2@api.test/v1/ping');
    expect(target).toBe('GET api.test/v1/ping');
    expect(target).not.toContain('hunter2');
  });

  it('reads method and url off a Request input', () => {
    const request = new Request('https://api.test/v1/items/7', { method: 'put' });
    expect(fetchTargetOf(request)).toBe('PUT api.test/v1/items/:id');
  });

  it('lets an explicit init method win over the Request method', () => {
    const request = new Request('https://api.test/v1/ping', { method: 'POST' });
    expect(fetchTargetOf(request, { method: 'head' })).toBe('HEAD api.test/v1/ping');
  });
});
