import { describe, it, expect } from 'vitest';
import { errorFrameFields } from '../src/internal/error-fields.js';

// The individual lifters are module-private since v1; `errorFrameFields` is the one
// entry the logger calls, so every case is asserted through the fields it emits.
const fields = (err: unknown) => errorFrameFields(err);

const systemError = (message: string, code: string): Error =>
  Object.assign(new Error(message), { code, errno: -3008, syscall: 'getaddrinfo' });

const withStack = (message: string, stack: string): Error => {
  const err = new Error(message);
  err.stack = `Error: ${message}\n${stack}`;
  return err;
};

describe('cause chain', () => {
  it('is empty for an error with no cause', () => {
    const solo = new Error('solo');
    solo.stack = undefined;
    expect(fields(solo)).toEqual({ category: 'logic' });
  });

  it('lifts the deepest system-error cause of a wrapped fetch failure', () => {
    const dns = systemError('getaddrinfo ENOTFOUND agentage-web_backend', 'ENOTFOUND');
    const middle = new Error('connect failed', { cause: dns });
    const err = new TypeError('fetch failed', { cause: middle });
    expect(fields(err)).toMatchObject({
      cause: 'Error: getaddrinfo ENOTFOUND agentage-web_backend',
      error_code: 'ENOTFOUND',
    });
  });

  it('appends the code when the message does not carry it', () => {
    const err = new Error('outer', { cause: systemError('socket hang up', 'ECONNRESET') });
    expect(fields(err).cause).toBe('Error: socket hang up (ECONNRESET)');
  });

  it('falls back to the deepest plain cause', () => {
    const err = new Error('outer', { cause: new RangeError('inner') });
    expect(fields(err).cause).toBe('RangeError: inner');
    expect(fields(err).error_code).toBeUndefined();
  });

  it('caps the walk at five causes', () => {
    let err = new Error('deepest');
    for (let i = 0; i < 8; i += 1) err = new Error(`wrap-${i}`, { cause: err });
    expect(fields(err).cause).toBe('Error: wrap-2');
  });

  it('survives a cycle', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    expect(fields(a).cause).toBe('Error: b');
  });
});

describe('frame', () => {
  it('picks the top in-app frame of the error stack', () => {
    const err = withStack(
      'boom',
      [
        '    at nodeHandler (/app/node_modules/undici/lib/fetch.js:11:2)',
        '    at provisionMemory (/app/src/provision.ts:42:11)',
        '    at run (/app/src/server.ts:9:1)',
      ].join('\n')
    );
    expect(fields(err).frame).toBe('src/provision.ts:42:11 in provisionMemory');
  });

  it('handles a bare location frame', () => {
    expect(fields(withStack('boom', '    at /app/src/boot.ts:3:7')).frame).toBe('src/boot.ts:3:7');
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
    expect(fields(err).frame).toBe('lib/vault.ts:8:3 in readVault');
  });

  it('falls back to a cause stack when the error has no app frame', () => {
    const cause = withStack('inner', '    at readVault (/srv/src/vault.ts:8:3)');
    const err = withStack('outer', '    at fetch (/app/node_modules/undici/index.js:1:1)');
    (err as Error & { cause?: unknown }).cause = cause;
    expect(fields(err).frame).toBe('src/vault.ts:8:3 in readVault');
  });

  it('falls back to callSite when neither the error nor its causes has an app frame', () => {
    const err = withStack('fetch failed', '    at node:internal/deps/undici/undici:1:1');
    Object.defineProperty(err, 'callSite', {
      value: 'Error: fetch call site\n    at provisionMemory (/app/src/provision.ts:42:11)',
      enumerable: false,
    });
    expect(fields(err).frame).toBe('src/provision.ts:42:11 in provisionMemory');
  });

  it('has no frame for a non-Error or a stackless error', () => {
    expect(fields('nope').frame).toBeUndefined();
    const err = new Error('bare');
    err.stack = undefined;
    expect(fields(err).frame).toBeUndefined();
  });
});

describe('category', () => {
  it('reads a timeout off the error name', () => {
    expect(fields(Object.assign(new Error('aborted'), { name: 'AbortError' })).category).toBe(
      'timeout'
    );
    expect(fields(Object.assign(new Error('timed out'), { name: 'TimeoutError' })).category).toBe(
      'timeout'
    );
  });

  it.each([
    'ABORT_ERR',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ])('classifies %s as timeout', (code) => {
    expect(fields(systemError('slow', code)).category).toBe('timeout');
  });

  it.each([
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'ECONNABORTED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UND_ERR_SOCKET',
  ])('classifies %s as connectivity', (code) => {
    expect(fields(systemError('net', code)).category).toBe('connectivity');
  });

  it.each(['23505', '42P01', '08006'])('classifies SQLSTATE %s as db', (code) => {
    expect(fields(systemError('duplicate key', code)).category).toBe('db');
  });

  it('falls back to logic for an unknown or absent code', () => {
    expect(fields(new Error('boom')).category).toBe('logic');
    expect(fields(systemError('weird', 'ESOMETHINGELSE')).category).toBe('logic');
    expect(fields('not an error').category).toBe('logic');
  });

  it('classifies by the ROOT cause, not the wrapper', () => {
    const dns = systemError('getaddrinfo ENOTFOUND backend', 'ENOTFOUND');
    const wrapped = new TypeError('fetch failed', { cause: dns });
    expect(fields(new Error('provision failed', { cause: wrapped })).category).toBe('connectivity');
  });

  it('does not mistake a five-char connectivity code for SQLSTATE', () => {
    expect(fields(systemError('broken pipe', 'EPIPE')).category).toBe('connectivity');
  });
});

describe('errorFrameFields', () => {
  it('omits every key it cannot derive, but always carries a category', () => {
    const err = new Error('plain');
    err.stack = 'Error: plain\n    at x (node:internal/x:1:1)';
    expect(errorFrameFields(err)).toEqual({ category: 'logic' });
  });

  it('returns cause, frame, system code, target and category together', () => {
    const dns = systemError('getaddrinfo ENOTFOUND backend', 'ENOTFOUND');
    dns.stack = 'Error: getaddrinfo ENOTFOUND backend\n    at gai (/app/src/dns.ts:1:1)';
    const err = new TypeError('fetch failed', { cause: dns });
    err.stack = 'TypeError: fetch failed\n    at f (/app/node_modules/undici/index.js:1:1)';
    Object.defineProperty(err, 'fetchTarget', {
      value: 'GET backend/v1/ping',
      configurable: true,
    });
    expect(errorFrameFields(err)).toEqual({
      cause: 'Error: getaddrinfo ENOTFOUND backend',
      frame: 'src/dns.ts:1:1 in gai',
      error_code: 'ENOTFOUND',
      target: 'GET backend/v1/ping',
      category: 'connectivity',
    });
  });
});
