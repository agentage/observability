import type { ClientErrorEvent } from './internal/error-fields.js';
import {
  formatTraceparent,
  randomHexId,
  SPAN_ID_BYTES,
  TRACE_ID_BYTES,
  type RandomSource,
} from './internal/traceparent.js';

export interface ObserveBrowserOptions {
  /** Collector URL, absolute or same-origin path. */
  endpoint: string;
  service: string;
  /** 0..1, default 1 - drop everything else before it is queued. */
  sampleRate?: number;
  userId?: string;
  /** Client-side ceiling, default 20 events per rolling minute. */
  maxPerMinute?: number;
  /** Batch interval, default 5000ms. */
  flushIntervalMs?: number;
  /** Default true - set false to leave `fetch` unpatched (no traceparent header). */
  propagate?: boolean;
}

/** @deprecated Use `ObserveBrowserOptions`; removed in 1.0 final. */
export type ErrorReporterOptions = ObserveBrowserOptions;

/** Minimal local DOM surface - the package compiles for Node, so `lib: dom` is not on. */
interface BeaconNavigator {
  userAgent?: string;
  sendBeacon?: (url: string, data?: unknown) => boolean;
}

interface ElementLike {
  setAttribute?: (name: string, value: string) => void;
  removeAttribute?: (name: string) => void;
}

interface ReporterDocument {
  visibilityState?: string;
  documentElement?: ElementLike;
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
}

/** The two history methods a client router calls - each one starts a new action. */
interface HistoryLike {
  pushState?: (...args: unknown[]) => void;
  replaceState?: (...args: unknown[]) => void;
}

interface ReporterWindow {
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
  location?: { pathname?: string; href?: string };
  history?: HistoryLike;
  onerror?: unknown;
}

/** Request/Headers seen structurally - the package compiles without `lib: dom`. */
interface HeadersLike {
  set?: (name: string, value: string) => void;
  forEach?: (callback: (value: string, name: string) => void) => void;
}

type BrowserFetch = (input: unknown, init?: Record<string, unknown>) => Promise<unknown>;

interface ReporterGlobals {
  window?: ReporterWindow;
  document?: ReporterDocument;
  navigator?: BeaconNavigator;
  console?: { error: (...args: unknown[]) => void };
  crypto?: RandomSource & { randomUUID?: () => string };
  Blob?: new (parts: unknown[], options?: { type?: string }) => unknown;
  fetch?: BrowserFetch;
}

interface ErrorEventLike {
  message?: string;
  error?: unknown;
  filename?: string;
  lineno?: number;
}

const DEFAULT_MAX_PER_MINUTE = 20;
const DEFAULT_FLUSH_MS = 5_000;
const MAX_QUEUE = 50;
const MAX_MESSAGE = 1_000;
const MAX_STACK = 4_000;
const MINUTE = 60_000;

// text/plain keeps sendBeacon preflight-free, so cross-origin collectors still receive it.
const BEACON_CONTENT_TYPE = 'text/plain;charset=UTF-8';

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}...` : value;

const describe = (arg: unknown): string => {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return typeof arg === 'object' && arg !== null ? JSON.stringify(arg) : String(arg);
  } catch {
    return String(arg);
  }
};

const errorOf = (value: unknown): Error | undefined => (value instanceof Error ? value : undefined);

const TRACEPARENT = 'traceparent';
/** Read it off `<html>` to print an error id, without importing anything. */
const TRACE_ATTRIBUTE = 'data-obs-trace';

let currentTraceId: string | undefined;

/**
 * The trace id of the action in flight - the same id the server request and its
 * error line carry, so a support UI can show it as "error id".
 */
export function getTraceId(): string | undefined {
  return currentTraceId;
}

const urlOf = (input: unknown): string | undefined => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  const url = (input as { url?: unknown } | undefined)?.url;
  return typeof url === 'string' ? url : undefined;
};

// Cross-origin requests are never touched: the header trips a CORS preflight and
// hands the id to a third party.
const isSameOrigin = (target: string, base: string | undefined): boolean => {
  if (!base) return false;
  try {
    return new URL(target, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
};

const carriesTraceparent = (record: Record<string, unknown>): boolean =>
  Object.keys(record).some((key) => key.toLowerCase() === TRACEPARENT);

const toRecord = (headers: unknown): Record<string, unknown> => {
  const forEach = (headers as HeadersLike).forEach;
  if (typeof forEach !== 'function') return headers as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  forEach.call(headers, (value: string, name: string) => {
    out[name] = value;
  });
  return out;
};

/** Adds the header to whichever of the three `HeadersInit` shapes was passed. */
const withTraceparent = (headers: unknown, value: string): unknown => {
  if (!headers) return { [TRACEPARENT]: value };
  if (Array.isArray(headers)) {
    const pairs = headers as unknown[][];
    return pairs.some((pair) => String(pair?.[0]).toLowerCase() === TRACEPARENT)
      ? pairs
      : [...pairs, [TRACEPARENT, value]];
  }
  const record = toRecord(headers);
  return carriesTraceparent(record) ? record : { ...record, [TRACEPARENT]: value };
};

/** A client-router navigation is a new user action, so it gets a new trace id. */
const patchHistory = (history: HistoryLike | undefined, onNavigate: () => void): (() => void) => {
  const noop = (): void => {};
  if (!history) return noop;
  const originals = { pushState: history.pushState, replaceState: history.replaceState };
  for (const name of ['pushState', 'replaceState'] as const) {
    const original = originals[name];
    if (!original) continue;
    history[name] = (...args: unknown[]): void => {
      original.apply(history, args);
      onNavigate();
    };
  }
  return () => {
    for (const name of ['pushState', 'replaceState'] as const) {
      if (originals[name]) history[name] = originals[name];
    }
  };
};

/**
 * Stamps `traceparent` on same-origin requests, a fresh span-id half per request
 * so they stay distinguishable under one action trace id.
 */
const patchFetch = (globals: ReporterGlobals, win: ReporterWindow): (() => void) => {
  const original = globals.fetch;
  const noop = (): void => {};
  if (!original) return noop;
  const patched: BrowserFetch = (input, init) => {
    const target = urlOf(input);
    if (!currentTraceId || !target || !isSameOrigin(target, win.location?.href)) {
      return original.call(globals, input, init);
    }
    const value = formatTraceparent(currentTraceId, randomHexId(SPAN_ID_BYTES, globals.crypto));
    const headers = (input as { headers?: HeadersLike } | undefined)?.headers;
    // A Request input carries its own headers - an `init.headers` would replace them.
    if (!init?.headers && typeof headers?.set === 'function') {
      headers.set(TRACEPARENT, value);
      return original.call(globals, input, init);
    }
    return original.call(globals, input, {
      ...init,
      headers: withTraceparent(init?.headers, value),
    });
  };
  globals.fetch = patched;
  return () => {
    if (globals.fetch === patched) globals.fetch = original;
  };
};

const uuid = (globals: ReporterGlobals): string => {
  const random = globals.crypto?.randomUUID;
  if (random) return random.call(globals.crypto);
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

/**
 * The browser half of the kit: reports uncaught errors, unhandled rejections and
 * `console.error` calls to a collector as the estate `ErrorEvent` shape, and mints
 * one W3C trace id per user action that rides along on same-origin `fetch` calls -
 * so a click, the requests it fired and the error it produced share one id.
 * Dependency-free and inert outside a browser; returns an uninstall function that
 * restores everything it patched and flushes what is still queued.
 */
export function observeBrowser(options: ObserveBrowserOptions): () => void {
  const globals = globalThis as unknown as ReporterGlobals;
  const win = globals.window;
  const noop = (): void => {};
  if (typeof win === 'undefined' || !win?.addEventListener) return noop;

  const doc = globals.document;
  const consoleRef = globals.console;
  const sampleRate = options.sampleRate ?? 1;
  const maxPerMinute = options.maxPerMinute ?? DEFAULT_MAX_PER_MINUTE;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_MS;

  let queue: ClientErrorEvent[] = [];
  let sentAt: number[] = [];
  let lastKey: string | undefined;
  let reporting = false;
  let installed = true;

  // One id per user action: install, then every history navigation. Finer than
  // that (per click) buys nothing and costs a patched EventTarget.
  const startAction = (): void => {
    currentTraceId = randomHexId(TRACE_ID_BYTES, globals.crypto);
    doc?.documentElement?.setAttribute?.(TRACE_ATTRIBUTE, currentTraceId);
  };

  const send = (): void => {
    if (!queue.length) return;
    const body = JSON.stringify({ events: queue });
    queue = [];
    const nav = globals.navigator;
    const payload = globals.Blob ? new globals.Blob([body], { type: BEACON_CONTENT_TYPE }) : body;
    try {
      if (nav?.sendBeacon?.call(nav, options.endpoint, payload)) return;
    } catch {
      // sendBeacon throws on an over-large payload - fall through to fetch.
    }
    try {
      void globals
        .fetch?.(options.endpoint, {
          method: 'POST',
          body,
          keepalive: true,
          credentials: 'omit',
          headers: { 'content-type': BEACON_CONTENT_TYPE },
        })
        ?.catch(noop);
    } catch {
      // A dead network is not worth surfacing to the page.
    }
  };

  const flush = (): void => {
    try {
      send();
    } catch {
      // Never let the reporter break the page.
    }
  };

  const allowed = (): boolean => {
    const now = Date.now();
    sentAt = sentAt.filter((at) => now - at < MINUTE);
    if (sentAt.length >= maxPerMinute) return false;
    sentAt.push(now);
    return true;
  };

  const report = (type: string, rawMessage: string, stack?: string): void => {
    if (reporting || !installed) return;
    reporting = true;
    try {
      const message = truncate(rawMessage || 'Unknown error', MAX_MESSAGE);
      const key = `${type}|${message}`;
      if (key === lastKey) return;
      lastKey = key;
      if (sampleRate < 1 && Math.random() >= sampleRate) return;
      if (!allowed()) return;
      queue.push({
        event_id: uuid(globals),
        ts: new Date().toISOString(),
        err: { type, message, ...(stack ? { stack: truncate(stack, MAX_STACK) } : {}) },
        route: win.location?.pathname,
        source: 'client',
        service: options.service,
        url: win.location?.href,
        user_agent: globals.navigator?.userAgent,
        ...(options.userId ? { user_id: options.userId } : {}),
        ...(currentTraceId ? { trace_id: currentTraceId } : {}),
      });
      if (queue.length >= MAX_QUEUE) send();
    } catch {
      // A reporter bug must never reach the application.
    } finally {
      reporting = false;
    }
  };

  const reportUnknown = (value: unknown, fallbackType: string, fallbackMessage?: string): void => {
    const err = errorOf(value);
    if (err) return report(err.name || fallbackType, err.message, err.stack);
    report(fallbackType, fallbackMessage ?? describe(value));
  };

  const onError = (event: unknown): void => {
    const detail = (event ?? {}) as ErrorEventLike;
    reportUnknown(detail.error, 'Error', detail.message);
  };

  const onRejection = (event: unknown): void => {
    const reason = (event as { reason?: unknown } | undefined)?.reason;
    reportUnknown(reason, 'UnhandledRejection');
  };

  const onPagehide = (): void => flush();
  const onVisibility = (): void => {
    if (doc?.visibilityState === 'hidden') flush();
  };
  const onPopstate = (): void => startAction();

  startAction();
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);
  win.addEventListener('pagehide', onPagehide);
  win.addEventListener('popstate', onPopstate);
  doc?.addEventListener?.('visibilitychange', onVisibility);

  const restoreHistory = patchHistory(win.history, startAction);
  const restoreFetch = options.propagate === false ? noop : patchFetch(globals, win);

  // Same error also reaches addEventListener('error') - identical keys collapse.
  const previousOnError = win.onerror;
  win.onerror = (message: unknown, _source?: unknown, _lineno?: unknown, _colno?: unknown) => {
    report('Error', describe(message));
    return false;
  };

  const originalConsoleError = consoleRef?.error;
  if (consoleRef && originalConsoleError) {
    consoleRef.error = (...args: unknown[]): void => {
      originalConsoleError.apply(consoleRef, args);
      const err = args.find(errorOf);
      if (err) reportUnknown(err, 'ConsoleError');
      else report('ConsoleError', args.map(describe).join(' '));
    };
  }

  const timer = setInterval(flush, flushIntervalMs);
  (timer as { unref?: () => void }).unref?.();

  return () => {
    if (!installed) return;
    installed = false;
    clearInterval(timer);
    win.removeEventListener?.('error', onError);
    win.removeEventListener?.('unhandledrejection', onRejection);
    win.removeEventListener?.('pagehide', onPagehide);
    win.removeEventListener?.('popstate', onPopstate);
    doc?.removeEventListener?.('visibilitychange', onVisibility);
    win.onerror = previousOnError;
    if (consoleRef && originalConsoleError) consoleRef.error = originalConsoleError;
    restoreHistory();
    restoreFetch();
    doc?.documentElement?.removeAttribute?.(TRACE_ATTRIBUTE);
    currentTraceId = undefined;
    flush();
  };
}

/** @deprecated Use `observeBrowser`; removed in 1.0 final. */
export function installErrorReporter(options: ErrorReporterOptions): () => void {
  return observeBrowser(options);
}
