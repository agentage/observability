import { routeFromUrl } from './span-names.js';

type FetchArgs = Parameters<typeof fetch>;
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

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
export function fetchTargetOf(input: FetchArgs[0], init?: FetchArgs[1]): string {
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

/**
 * `fetch` with the calling stack preserved: an undici rejection (`TypeError: fetch
 * failed`) carries no application frame, so the call site is captured BEFORE the
 * await and attached to the thrown error as a non-enumerable `callSite`, alongside
 * a `fetchTarget` naming what was being called (the rejection does not say).
 */
export async function tracedFetch(
  input: FetchArgs[0],
  init?: FetchArgs[1]
): Promise<FetchResponse> {
  const callSite = new Error('fetch call site').stack;
  const fetchTarget = fetchTargetOf(input, init);
  try {
    return await fetch(input, init);
  } catch (err) {
    if (err instanceof Error) {
      if (callSite) attach(err, 'callSite', callSite);
      attach(err, 'fetchTarget', fetchTarget);
    }
    throw err;
  }
}
