import { routeFromUrl } from '../span-names.js';

type FetchArgs = Parameters<typeof fetch>;
type FetchResponse = Awaited<ReturnType<typeof fetch>>;
type Fetch = typeof fetch;

const isRequest = (input: FetchArgs[0]): input is Request =>
  typeof input === 'object' && input !== null && 'method' in input && 'url' in input;

const urlOf = (input: FetchArgs[0]): string =>
  isRequest(input) ? input.url : typeof input === 'string' ? input : String(input);

const methodOf = (input: FetchArgs[0], init?: FetchArgs[1]): string =>
  (init?.method ?? (isRequest(input) ? input.method : undefined) ?? 'GET').toUpperCase();

/**
 * `POST api.example.com:8443/v1/memories/:id` - what was being called, at the
 * cardinality a facet can group on. Credentials are dropped with the rest of the
 * authority; the path is templated by the same rule that names fetch spans.
 */
function fetchTargetOf(input: FetchArgs[0], init?: FetchArgs[1]): string {
  const raw = urlOf(input);
  const method = methodOf(input, init);
  let host = '';
  try {
    // `host` (not `hostname`) keeps a non-default port; `username`/`password` are left behind.
    host = new URL(raw).host;
  } catch {
    host = '';
  }
  return `${method} ${host}${routeFromUrl(raw)}`;
}

const attach = (err: Error, key: string, value: string): void => {
  if (key in err) return;
  Object.defineProperty(err, key, {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
};

/** Marks the installed wrapper, so a second bootstrap does not wrap the wrapper. */
const PATCHED = Symbol.for('agentage.observability.fetch.patched');

const isPatched = (fn: Fetch): boolean => PATCHED in fn;

/**
 * The enrichment itself: an undici rejection (`TypeError: fetch failed`) carries
 * no application frame and never says what it was calling, so the call site is
 * captured in the rejection branch and attached as a non-enumerable `callSite`,
 * alongside a `fetchTarget` naming the endpoint. Both are what make `frame` and
 * `target` point at your code on the error line.
 */
export function wrapFetch(inner: Fetch): Fetch {
  const wrapped = async function fetch(
    input: FetchArgs[0],
    init?: FetchArgs[1]
  ): Promise<FetchResponse> {
    try {
      return await inner(input, init);
    } catch (err) {
      if (err instanceof Error) {
        // Built here, not before the await: V8 async stack traces still reach the
        // awaiting caller, and the success path pays for neither.
        const callSite = new Error('fetch call site').stack;
        if (callSite) attach(err, 'callSite', callSite);
        attach(err, 'fetchTarget', fetchTargetOf(input, init));
      }
      throw err;
    }
  };
  Object.defineProperty(wrapped, PATCHED, { value: true });
  return wrapped as Fetch;
}

/**
 * Wrap the global `fetch` once, so every outbound call in the process gets the
 * enrichment with no import to remember. `OBS_FETCH_PATCH=off` opts out.
 * Returns whether the wrap was installed.
 */
export function installFetchPatch(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.OBS_FETCH_PATCH ?? '').trim().toLowerCase() === 'off') return false;
  const current = globalThis.fetch;
  if (typeof current !== 'function' || isPatched(current)) return false;
  globalThis.fetch = wrapFetch(current);
  return true;
}
