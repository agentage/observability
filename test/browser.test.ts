import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installErrorReporter } from '../src/browser.js';

type Listener = (event: unknown) => void;

interface Beacon {
  url: string;
  events: Record<string, unknown>[];
}

const beacons: Beacon[] = [];
let listeners: Record<string, Listener[]>;
let docListeners: Record<string, Listener[]>;
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
  globals.window = {
    addEventListener: (type: string, listener: Listener) => {
      (listeners[type] ??= []).push(listener);
    },
    removeEventListener: (type: string, listener: Listener) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== listener);
    },
    location: { pathname: '/dashboard', href: 'https://app.test/dashboard?q=1' },
  };
  globals.document = {
    visibilityState: 'visible',
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

const install = (options: Partial<Parameters<typeof installErrorReporter>[0]> = {}) => {
  uninstall = installErrorReporter({ endpoint: '/api/client-errors', service: 'web', ...options });
  return uninstall;
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
});
