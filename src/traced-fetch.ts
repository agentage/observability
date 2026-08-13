type FetchArgs = Parameters<typeof fetch>;
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/**
 * `fetch` with the calling stack preserved: an undici rejection (`TypeError: fetch
 * failed`) carries no application frame, so the call site is captured BEFORE the
 * await and attached to the thrown error as a non-enumerable `callSite`.
 */
export async function tracedFetch(
  input: FetchArgs[0],
  init?: FetchArgs[1]
): Promise<FetchResponse> {
  const callSite = new Error('fetch call site').stack;
  try {
    return await fetch(input, init);
  } catch (err) {
    if (err instanceof Error && callSite && !('callSite' in err)) {
      Object.defineProperty(err, 'callSite', {
        value: callSite,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    throw err;
  }
}
