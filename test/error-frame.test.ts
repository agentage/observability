import { describe, it, expect } from 'vitest';
import {
  causeChainOf,
  causeCodeOf,
  causeSummaryOf,
  errorFrameFields,
  frameOf,
  rootCauseOf,
} from '../src/error-frame.js';

const systemError = (message: string, code: string): Error =>
  Object.assign(new Error(message), { code, errno: -3008, syscall: 'getaddrinfo' });

const withStack = (message: string, stack: string): Error => {
  const err = new Error(message);
  err.stack = `Error: ${message}\n${stack}`;
  return err;
};

describe('cause chain', () => {
  it('is empty for an error with no cause', () => {
    const err = new Error('solo');
    expect(causeChainOf(err)).toEqual([]);
    expect(rootCauseOf(err)).toBeUndefined();
    expect(causeSummaryOf(err)).toBeUndefined();
    expect(causeCodeOf(err)).toBeUndefined();
  });

  it('lifts the deepest system-error cause of a wrapped fetch failure', () => {
    const dns = systemError('getaddrinfo ENOTFOUND agentage-web_backend', 'ENOTFOUND');
    const middle = new Error('connect failed', { cause: dns });
    const err = new TypeError('fetch failed', { cause: middle });
    expect(rootCauseOf(err)).toBe(dns);
    expect(causeCodeOf(err)).toBe('ENOTFOUND');
    expect(causeSummaryOf(err)).toBe('Error: getaddrinfo ENOTFOUND agentage-web_backend');
  });

  it('appends the code when the message does not carry it', () => {
    const err = new Error('outer', { cause: systemError('socket hang up', 'ECONNRESET') });
    expect(causeSummaryOf(err)).toBe('Error: socket hang up (ECONNRESET)');
  });

  it('falls back to the deepest plain cause', () => {
    const err = new Error('outer', { cause: new RangeError('inner') });
    expect(causeSummaryOf(err)).toBe('RangeError: inner');
    expect(causeCodeOf(err)).toBeUndefined();
  });

  it('caps the walk at five causes', () => {
    let err = new Error('deepest');
    for (let i = 0; i < 8; i += 1) err = new Error(`wrap-${i}`, { cause: err });
    expect(causeChainOf(err)).toHaveLength(5);
  });

  it('survives a cycle', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    expect(causeChainOf(a)).toEqual([b]);
    expect(causeSummaryOf(a)).toBe('Error: b');
  });
});

describe('frameOf', () => {
  it('picks the top in-app frame of the error stack', () => {
    const err = withStack(
      'boom',
      [
        '    at nodeHandler (/app/node_modules/undici/lib/fetch.js:11:2)',
        '    at provisionMemory (/app/src/provision.ts:42:11)',
        '    at run (/app/src/server.ts:9:1)',
      ].join('\n')
    );
    expect(frameOf(err)).toBe('src/provision.ts:42:11 in provisionMemory');
  });

  it('handles a bare location frame', () => {
    const err = withStack('boom', '    at /app/src/boot.ts:3:7');
    expect(frameOf(err)).toBe('src/boot.ts:3:7');
  });

  it('skips node internals and native frames', () => {
    const err = withStack(
      'boom',
      [
        '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
        '    at Array.forEach (<anonymous>)',
        '    at load (webpack-internal:///./app/page.tsx:5:1)',
        '    at readVault (/srv/lib/vault.ts:8:3)',
      ].join('\n')
    );
    expect(frameOf(err)).toBe('lib/vault.ts:8:3 in readVault');
  });

  it('falls back to a cause stack when the error has no app frame', () => {
    const cause = withStack('inner', '    at readVault (/srv/src/vault.ts:8:3)');
    const err = withStack('outer', '    at fetch (/app/node_modules/undici/index.js:1:1)');
    (err as Error & { cause?: unknown }).cause = cause;
    expect(frameOf(err)).toBe('src/vault.ts:8:3 in readVault');
  });

  it('falls back to callSite when neither the error nor its causes has an app frame', () => {
    const err = withStack('fetch failed', '    at node:internal/deps/undici/undici:1:1');
    Object.defineProperty(err, 'callSite', {
      value: 'Error: fetch call site\n    at provisionMemory (/app/src/provision.ts:42:11)',
      enumerable: false,
    });
    expect(frameOf(err)).toBe('src/provision.ts:42:11 in provisionMemory');
  });

  it('returns undefined for a non-Error and for a stackless error', () => {
    expect(frameOf('nope')).toBeUndefined();
    const err = new Error('bare');
    err.stack = undefined;
    expect(frameOf(err)).toBeUndefined();
  });
});

describe('errorFrameFields', () => {
  it('omits every key it cannot derive', () => {
    const err = new Error('plain');
    err.stack = 'Error: plain\n    at x (node:internal/x:1:1)';
    expect(errorFrameFields(err)).toEqual({});
  });

  it('returns cause, frame and the system code together', () => {
    const dns = systemError('getaddrinfo ENOTFOUND backend', 'ENOTFOUND');
    dns.stack = 'Error: getaddrinfo ENOTFOUND backend\n    at gai (/app/src/dns.ts:1:1)';
    const err = new TypeError('fetch failed', { cause: dns });
    err.stack = 'TypeError: fetch failed\n    at f (/app/node_modules/undici/index.js:1:1)';
    expect(errorFrameFields(err)).toEqual({
      cause: 'Error: getaddrinfo ENOTFOUND backend',
      frame: 'src/dns.ts:1:1 in gai',
      error_code: 'ENOTFOUND',
    });
  });
});
