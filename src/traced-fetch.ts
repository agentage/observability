type FetchArgs = Parameters<typeof fetch>;
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/**
 * Plain `fetch`. The call-site and target enrichment it used to add is now
 * installed on the global `fetch` by the bootstrap, so every outbound call gets
 * it without an import.
 *
 * @deprecated Call `fetch` directly; removed in 1.0 final.
 */
export function tracedFetch(input: FetchArgs[0], init?: FetchArgs[1]): Promise<FetchResponse> {
  return fetch(input, init);
}
