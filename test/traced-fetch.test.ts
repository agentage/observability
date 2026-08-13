import { describe, it, expect, vi, afterEach } from 'vitest';
import { tracedFetch } from '../src/traced-fetch.js';
import { frameOf } from '../src/error-frame.js';

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
});
