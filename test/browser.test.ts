import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getTraceId, installErrorReporter, observeBrowser } from '../src/browser.js';

type Listener = (event: unknown) => void;

interface Beacon {
  url: string;
  events: Record<string, unknown>[];
}

interface FetchCall {
  input: unknown;
  init?: Record<string, unknown>;
}

const beacons: Beacon[] = [];
const fetchCalls: FetchCall[] = [];
let listeners: Record<string, Listener[]>;
let docListeners: Record<string, Listener[]>;
let attributes: Record<string, string>;
let uninstall: (() => void) | undefined;

const globals = globalThis as unknown as Record<string, unknown>;

const emit = (type: string, event: unknown): void => {
  for (const listener of listeners[type] ?? []) listener(event);
};

const bodyOf = (data: unknown): string =>
  typeof data === 'string' ? data : ((data as { parts: string[] }).parts[0] ?? '');

function stubBrowser(): void {
  listeners = {};
  docListeners = {};
  beacons.length = 0;
  attributes = {};
  fetchCalls.length = 0;
  globals.window = {
    addEventListener: (type: string, listener: Listener) => {
      (listeners[type] ??= []).push(listener);
    },
    removeEventListener: (type: string, listener: Listener) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== listener);
    },
    location: { pathname: '/dashboard', href: 'https://app.test/dashboard?q=1' },
    history: {
      pushState: () => {},
      replaceState: () => {},
    },
  };
  globals.document = {
    visibilityState: 'visible',
    documentElement: {
      setAttribute: (name: string, value: string) => {
        attributes[name] = value;
      },
      removeAttribute: (name: string) => {
        delete attributes[name];
      },
    },
    addEventListener: (type: string, listener: Listener) => {
      (docListeners[type] ??= []).push(listener);
    },
    removeEventListener: (type: string, listener: Listener) => {
      docListeners[type] = (docListeners[type] ?? []).filter((l) => l !== listener);
    },
  };
  // globalThis.navigator is getter-only on Node, so it has to be redefined.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      userAgent: 'test-agent/1.0',
      sendBeacon: (url: string, data: unknown) => {
        beacons.push({ url, events: JSON.parse(bodyOf(data)).events });
        return true;
      },
    },
  });
  globals.Blob = class {
    parts: string[];
    constructor(parts: string[]) {
      this.parts = parts;
    }
  };
}

const install = (options: Partial<Parameters<typeof observeBrowser>[0]> = {}) => {
  uninstall = observeBrowser({ endpoint: '/api/client-errors', service: 'web', ...options });
  return uninstall;
};

// A collector-bound fetch is recorded, never sent - the reporter's own POST included.
const stubFetch = (): void => {
  globals.fetch = (input: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ input, init });
    return Promise.resolve({});
  };
};

const callFetch = (input: unknown, init?: Record<string, unknown>): void => {
  void (globals.fetch as (i: unknown, x?: Record<string, unknown>) => Promise<unknown>)(
    input,
    init
  );
};

const traceparentOf = (call: FetchCall): string | undefined => {
  const headers = call.init?.headers as Record<string, string> | undefined;
  return headers?.traceparent;
};

const flushed = (): Record<string, unknown>[] => beacons.flatMap((b) => b.events);

beforeEach(stubBrowser);

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  delete globals.window;
  delete globals.document;
  delete globals.navigator;
  delete globals.Blob;
  delete globals.fetch;
});

describe('installErrorReporter', () => {
  it('is inert outside a browser', () => {
    delete globals.window;
    const stop = installErrorReporter({ endpoint: '/e', service: 'web' });
    expect(typeof stop).toBe('function');
    stop();
    expect(beacons).toHaveLength(0);
  });

  it('reports window errors in the client event shape', () => {
    const stop = install();
    emit('error', {
      error: Object.assign(new TypeError('boom'), { stack: 'TypeError: boom\n at x' }),
    });
    stop();
    uninstall = undefined;
    const [event] = flushed();
    expect(beacons[0].url).toBe('/api/client-errors');
    expect(event.err).toEqual({
      type: 'TypeError',
      message: 'boom',
      stack: 'TypeError: boom\n at x',
    });
    expect(event.route).toBe('/dashboard');
    expect(event.url).toBe('https://app.test/dashboard?q=1');
    expect(event.source).toBe('client');
    expect(event.service).toBe('web');
    expect(event.user_agent).toBe('test-agent/1.0');
    expect(typeof event.event_id).toBe('string');
    expect(typeof event.ts).toBe('string');
    expect(event.user_id).toBeUndefined();
  });

  it('carries user_id when configured', () => {
    const stop = install({ userId: 'u1' });
    emit('error', { message: 'plain' });
    stop();
    uninstall = undefined;
    expect(flushed()[0].user_id).toBe('u1');
  });

  it('dedupes window.onerror against the error listener', () => {
    const stop = install();
    const win = globals.window as { onerror: (message: string) => boolean };
    emit('error', { error: new Error('same') });
    win.onerror('same');
    stop();
    uninstall = undefined;
    expect(flushed()).toHaveLength(1);
  });

  it('reports unhandled rejections', () => {
    const stop = install();
    emit('unhandledrejection', { reason: new Error('rejected') });
    stop();
    uninstall = undefined;
    expect(flushed()[0].err).toMatchObject({ type: 'Error', message: 'rejected' });
  });

  it('patches console.error with call-through and no recursion', () => {
    const original = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stop = install();
    console.error('bad thing', { a: 1 });
    stop();
    uninstall = undefined;
    expect(original).toHaveBeenCalledWith('bad thing', { a: 1 });
    expect(flushed()[0].err).toMatchObject({ type: 'ConsoleError', message: 'bad thing {"a":1}' });
    original.mockRestore();
  });

  it('rate limits and drops identical consecutive messages', () => {
    const stop = install({ maxPerMinute: 2 });
    emit('error', { message: 'a' });
    emit('error', { message: 'a' });
    emit('error', { message: 'b' });
    emit('error', { message: 'c' });
    stop();
    uninstall = undefined;
    expect(flushed().map((e) => (e.err as { message: string }).message)).toEqual(['a', 'b']);
  });

  it('drops everything when sampled out', () => {
    const stop = install({ sampleRate: 0 });
    emit('error', { message: 'sampled' });
    stop();
    uninstall = undefined;
    expect(flushed()).toHaveLength(0);
  });

  it('flushes on hidden visibility and on the interval', () => {
    vi.useFakeTimers();
    install({ flushIntervalMs: 1000 });
    emit('error', { message: 'first' });
    (globals.document as { visibilityState: string }).visibilityState = 'hidden';
    for (const listener of docListeners.visibilitychange ?? []) listener({});
    expect(flushed()).toHaveLength(1);
    emit('error', { message: 'second' });
    vi.advanceTimersByTime(1000);
    expect(flushed()).toHaveLength(2);
    vi.useRealTimers();
  });

  it('falls back to fetch keepalive when sendBeacon is unavailable', () => {
    const fetchMock = vi.fn(() => Promise.resolve({}));
    globals.fetch = fetchMock;
    delete (globals.navigator as { sendBeacon?: unknown }).sendBeacon;
    const stop = install();
    emit('error', { message: 'no beacon' });
    stop();
    uninstall = undefined;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body as string).events).toHaveLength(1);
  });

  it('never throws when the transport does', () => {
    (globals.navigator as { sendBeacon: () => boolean }).sendBeacon = () => {
      throw new Error('beacon exploded');
    };
    delete globals.fetch;
    const stop = install();
    emit('error', { message: 'x' });
    expect(() => stop()).not.toThrow();
    uninstall = undefined;
  });

  it('restores console.error and listeners on uninstall', () => {
    const before = console.error;
    const stop = install();
    expect(console.error).not.toBe(before);
    stop();
    uninstall = undefined;
    expect(console.error).toBe(before);
    expect(listeners.error).toHaveLength(0);
    emit('unhandledrejection', { reason: new Error('after') });
    expect(flushed()).toHaveLength(0);
  });

  it('still works under the deprecated installErrorReporter name', () => {
    const stop = installErrorReporter({ endpoint: '/api/client-errors', service: 'web' });
    expect(typeof getTraceId()).toBe('string');
    emit('error', { message: 'legacy' });
    stop();
    expect(flushed()[0].err).toMatchObject({ message: 'legacy' });
  });
});

describe('action trace ids', () => {
  // 00 version, non-zero trace and span ids, sampled - the estate keeps the trace whole.
  const TRACEPARENT = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-01$/;

  it('mints a sampled traceparent and publishes it two ways', () => {
    stubFetch();
    install();
    const traceId = getTraceId();
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(attributes['data-obs-trace']).toBe(traceId);
    callFetch('/api/memories');
    const traceparent = traceparentOf(fetchCalls[0]);
    expect(traceparent).toMatch(TRACEPARENT);
    expect(traceparent?.split('-')[1]).toBe(traceId);
  });

  it('never mints an all-zero id, even from a dead random source', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    // Zeros from the real API, then no API at all (the Math.random fallback).
    for (const value of [{ getRandomValues: (array: Uint8Array) => array.fill(0) }, {}]) {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value });
      stubFetch();
      const stop = install();
      callFetch('/api/memories');
      expect(traceparentOf(fetchCalls[fetchCalls.length - 1])).toMatch(TRACEPARENT);
      stop();
      uninstall = undefined;
    }
    if (original) Object.defineProperty(globalThis, 'crypto', original);
  });

  it('starts a new action on every history navigation', () => {
    install();
    const history = (globals.window as { history: Record<string, () => void> }).history;
    const first = getTraceId();
    history.pushState();
    const second = getTraceId();
    history.replaceState();
    const third = getTraceId();
    emit('popstate', {});
    const fourth = getTraceId();
    expect(new Set([first, second, third, fourth]).size).toBe(4);
    expect(attributes['data-obs-trace']).toBe(fourth);
  });

  it('keeps the trace id stable per action and the span id fresh per request', () => {
    stubFetch();
    install();
    callFetch('/api/a');
    callFetch('/api/b');
    const [a, b] = fetchCalls.map((call) => traceparentOf(call)?.split('-') ?? []);
    expect(a[1]).toBe(b[1]);
    expect(a[2]).not.toBe(b[2]);
  });

  it('leaves cross-origin requests untouched', () => {
    stubFetch();
    install();
    callFetch('https://analytics.test/collect', { method: 'POST' });
    callFetch('https://app.test/api/same', { method: 'POST' });
    expect(traceparentOf(fetchCalls[0])).toBeUndefined();
    expect(fetchCalls[0].init?.method).toBe('POST');
    expect(traceparentOf(fetchCalls[1])).toMatch(TRACEPARENT);
  });

  it('merges into the headers the caller passed and never overwrites one', () => {
    stubFetch();
    install();
    callFetch('/api/a', { headers: { authorization: 'Bearer x' } });
    callFetch('/api/b', { headers: { traceparent: '00-aaa-bbb-01' } });
    expect(fetchCalls[0].init?.headers).toMatchObject({ authorization: 'Bearer x' });
    expect(traceparentOf(fetchCalls[0])).toMatch(TRACEPARENT);
    expect(traceparentOf(fetchCalls[1])).toBe('00-aaa-bbb-01');
  });

  it('handles the Headers and entry-array header shapes', () => {
    stubFetch();
    install();
    const headers = {
      forEach: (cb: (v: string, k: string) => void) => cb('application/json', 'accept'),
    };
    callFetch('/api/a', { headers });
    callFetch('/api/b', { headers: [['accept', 'application/json']] });
    expect(fetchCalls[0].init?.headers).toMatchObject({ accept: 'application/json' });
    expect(traceparentOf(fetchCalls[0])).toMatch(TRACEPARENT);
    const pairs = fetchCalls[1].init?.headers as string[][];
    expect(pairs).toHaveLength(2);
    expect(pairs[1][0]).toBe('traceparent');
    expect(pairs[1][1]).toMatch(TRACEPARENT);
  });

  it('stamps a Request input on its own headers', () => {
    stubFetch();
    install();
    const set = vi.fn();
    callFetch({ url: 'https://app.test/api/a', headers: { set } });
    expect(set).toHaveBeenCalledWith('traceparent', expect.stringMatching(TRACEPARENT));
    expect(fetchCalls[0].init).toBeUndefined();
  });

  it('reports the action trace id on every error', () => {
    const stop = install();
    emit('error', { message: 'traced' });
    const traceId = getTraceId();
    stop();
    uninstall = undefined;
    expect(flushed()[0].trace_id).toBe(traceId);
  });

  it('leaves fetch alone when propagate is false', () => {
    stubFetch();
    const before = globals.fetch;
    install({ propagate: false });
    expect(globals.fetch).toBe(before);
    callFetch('/api/memories');
    expect(traceparentOf(fetchCalls[0])).toBeUndefined();
    expect(getTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('restores fetch, history and the attribute on uninstall', () => {
    stubFetch();
    const before = globals.fetch;
    const history = (globals.window as { history: Record<string, unknown> }).history;
    const pushState = history.pushState;
    const stop = install();
    expect(globals.fetch).not.toBe(before);
    expect(history.pushState).not.toBe(pushState);
    stop();
    uninstall = undefined;
    expect(globals.fetch).toBe(before);
    expect(history.pushState).toBe(pushState);
    expect(attributes['data-obs-trace']).toBeUndefined();
    expect(getTraceId()).toBeUndefined();
    callFetch('/api/memories');
    expect(traceparentOf(fetchCalls[0])).toBeUndefined();
  });
});
