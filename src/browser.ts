import type { ClientErrorEvent } from './error-event.js';

export interface ErrorReporterOptions {
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
}

/** Minimal local DOM surface - the package compiles for Node, so `lib: dom` is not on. */
interface BeaconNavigator {
  userAgent?: string;
  sendBeacon?: (url: string, data?: unknown) => boolean;
}

interface ReporterDocument {
  visibilityState?: string;
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
}

interface ReporterWindow {
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
  location?: { pathname?: string; href?: string };
  onerror?: unknown;
}

interface ReporterGlobals {
  window?: ReporterWindow;
  document?: ReporterDocument;
  navigator?: BeaconNavigator;
  console?: { error: (...args: unknown[]) => void };
  crypto?: { randomUUID?: () => string };
  Blob?: new (parts: unknown[], options?: { type?: string }) => unknown;
  fetch?: (url: string, init: Record<string, unknown>) => Promise<unknown>;
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

const uuid = (globals: ReporterGlobals): string => {
  const random = globals.crypto?.randomUUID;
  if (random) return random.call(globals.crypto);
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

/**
 * Reports uncaught errors, unhandled rejections and `console.error` calls to a
 * collector as the estate `ErrorEvent` shape. Dependency-free and inert outside
 * a browser; returns an uninstall function that flushes what is still queued.
 */
export function installErrorReporter(options: ErrorReporterOptions): () => void {
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

  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);
  win.addEventListener('pagehide', onPagehide);
  doc?.addEventListener?.('visibilitychange', onVisibility);

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
    doc?.removeEventListener?.('visibilitychange', onVisibility);
    win.onerror = previousOnError;
    if (consoleRef && originalConsoleError) consoleRef.error = originalConsoleError;
    flush();
  };
}
