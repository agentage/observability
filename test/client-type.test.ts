import { describe, it, expect, vi, afterEach } from 'vitest';
import { context as otelContext, trace } from '@opentelemetry/api';
import { useStackContextManager } from './stack-context-manager.js';
import {
  CLIENT_TYPE_HEADER,
  classifyClientType,
  contextWithUserType,
  stampUserType,
  userTypeFromContext,
} from '../src/client-type.js';

afterEach(() => {
  otelContext.disable();
  vi.restoreAllMocks();
});

describe('classifyClientType', () => {
  it('lets the header win over a browser user agent', () => {
    expect(CLIENT_TYPE_HEADER).toBe('x-client-type');
    expect(classifyClientType({ header: 'test', userAgent: 'Mozilla/5.0 Chrome/141' })).toBe(
      'test'
    );
    expect(classifyClientType({ header: 'Service', userAgent: 'Playwright/1.5' })).toBe('service');
  });

  it('falls back to the user agent when no header is sent', () => {
    expect(classifyClientType({ userAgent: 'Mozilla/5.0 HeadlessChrome/141' })).toBe('test');
    expect(classifyClientType({ userAgent: 'Playwright/1.55' })).toBe('test');
    expect(classifyClientType({ userAgent: 'puppeteer' })).toBe('test');
    expect(classifyClientType({ userAgent: 'curl/8.5.0' })).toBe('bot');
    expect(classifyClientType({ userAgent: 'Googlebot/2.1' })).toBe('bot');
  });

  it('classifies scanner paths as bots and everything else as a user', () => {
    expect(classifyClientType({ path: '/wp-login.php' })).toBe('bot');
    expect(classifyClientType({ path: '/.git/config' })).toBe('bot');
    expect(classifyClientType({ userAgent: 'Mozilla/5.0 Safari/605', path: '/memories' })).toBe(
      'user'
    );
    expect(classifyClientType({})).toBe('user');
  });

  it('ignores an unknown header value', () => {
    expect(classifyClientType({ header: 'robot', userAgent: 'Mozilla/5.0' })).toBe('user');
  });
});

describe('user_type on spans', () => {
  it('stamps the context value on the given span', () => {
    const span = { setAttribute: vi.fn() };
    otelContext.with(contextWithUserType('test'), () => {
      // no context manager registered - read straight from the context instead
      expect(userTypeFromContext(contextWithUserType('test'))).toBe('test');
    });
    useStackContextManager();
    otelContext.with(contextWithUserType('test'), () => {
      expect(stampUserType(span as never)).toBe('test');
    });
    expect(span.setAttribute).toHaveBeenCalledWith('user_type', 'test');
  });

  it('stamps the active span when none is given', () => {
    useStackContextManager();
    const span = { setAttribute: vi.fn() };
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span as never);
    otelContext.with(contextWithUserType('bot'), () => stampUserType());
    expect(span.setAttribute).toHaveBeenCalledWith('user_type', 'bot');
  });

  it('is a no-op when nothing was classified', () => {
    const span = { setAttribute: vi.fn() };
    expect(stampUserType(span as never)).toBeUndefined();
    expect(span.setAttribute).not.toHaveBeenCalled();
    expect(userTypeFromContext()).toBeUndefined();
  });

  it('propagates to nested contexts and keeps other baggage', () => {
    useStackContextManager();
    otelContext.with(contextWithUserType('service'), () => {
      otelContext.with(contextWithUserType('service'), () => {
        expect(userTypeFromContext()).toBe('service');
      });
      expect(userTypeFromContext()).toBe('service');
    });
    expect(userTypeFromContext()).toBeUndefined();
  });
});
