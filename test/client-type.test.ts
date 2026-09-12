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

  it('classifies scanner paths as bots and a browser as a user', () => {
    expect(classifyClientType({ path: '/wp-login.php' })).toBe('bot');
    expect(classifyClientType({ path: '/.git/config' })).toBe('bot');
    expect(classifyClientType({ userAgent: 'Mozilla/5.0 Safari/605', path: '/memories' })).toBe(
      'user'
    );
  });

  it('ignores an unknown header value', () => {
    expect(classifyClientType({ header: 'robot', userAgent: 'Mozilla/5.0' })).toBe('user');
  });

  it('honors an upstream bot verdict from the header', () => {
    expect(classifyClientType({ header: 'Bot', userAgent: 'Mozilla/5.0 Chrome/141' })).toBe('bot');
  });
});

// The edge VRL classifies a machine caller as `service`; the kit must agree, or
// SSR fetches that set no headers count as real visitors.
describe('classifyClientType machine callers (VRL lockstep)', () => {
  it('treats an empty or absent user agent as a service', () => {
    expect(classifyClientType({})).toBe('service');
    expect(classifyClientType({ userAgent: '', path: '/api/mcps' })).toBe('service');
  });

  it.each([
    'node',
    'node/22.13.0',
    'node-fetch/1.0',
    'undici',
    'axios/1.2',
    'got (https://github.com/sindresorhus/got)',
    'python-urllib/3.11',
    'aiohttp/3.9',
    'httpx/0.27',
    'Go-http-client/1.1',
    'okhttp/4.12',
    'Java/17.0.9',
    'Apache-HttpClient/4.5.13',
    'libwww-perl/6.68',
    'GuzzleHttp/7',
    'PostmanRuntime/7.36',
  ])('classifies %s as a service', (userAgent) => {
    expect(classifyClientType({ userAgent })).toBe('service');
  });

  it('keeps the bot verdict for machine UAs the bot rule already claims', () => {
    expect(classifyClientType({ userAgent: 'curl/8.5.0' })).toBe('bot');
    expect(classifyClientType({ userAgent: 'python-requests/2.31' })).toBe('bot');
    expect(classifyClientType({ userAgent: '', path: '/wp-login.php' })).toBe('bot');
  });

  it('does not match a machine name appearing mid-agent', () => {
    expect(classifyClientType({ userAgent: 'Mozilla/5.0 (node.js embedded)' })).toBe('user');
    expect(classifyClientType({ userAgent: 'nodeish/1.0' })).toBe('user');
  });
});

describe('bot ip ranges', () => {
  const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36';
  const RANGES = ['57.141.20.0/22'];

  it('classifies a disguised browser UA as a bot when the ip is in range', () => {
    expect(classifyClientType({ userAgent: CHROME, ip: '57.141.23.9', botIpRanges: RANGES })).toBe(
      'bot'
    );
  });

  it('leaves the same request a user when the ip is outside every range', () => {
    expect(classifyClientType({ userAgent: CHROME, ip: '57.141.24.1', botIpRanges: RANGES })).toBe(
      'user'
    );
    expect(classifyClientType({ userAgent: CHROME, ip: '57.141.23.9' })).toBe('user');
  });

  it('never lets a malformed ip or range change the verdict', () => {
    for (const ip of ['', 'not-an-ip', '999.1.1.1', '1.2.3', '2001:db8::1', '::ffff:57.141.23.9']) {
      expect(classifyClientType({ userAgent: CHROME, ip, botIpRanges: RANGES })).toBe('user');
    }
    for (const range of ['', '57.141.20.0/', '57.141.20.0/33', 'nonsense', '1.2.3.4/8/8']) {
      expect(
        classifyClientType({ userAgent: CHROME, ip: '57.141.23.9', botIpRanges: [range] })
      ).toBe('user');
    }
  });

  it('ranks the ip rule with the other bot rules, below service and test', () => {
    const inRange = { ip: '57.141.23.9', botIpRanges: RANGES };
    expect(classifyClientType({ ...inRange, header: 'service' })).toBe('service');
    expect(classifyClientType({ ...inRange, header: 'test' })).toBe('test');
    expect(classifyClientType({ ...inRange, userAgent: 'node' })).toBe('bot');
  });
});

// The CIDR matcher is module-private since v1; `botIpRanges` is how a caller reaches it.
describe('bot IP ranges', () => {
  const isBot = (ip: string | undefined, ranges: readonly string[] | undefined): boolean =>
    classifyClientType({ userAgent: 'Mozilla/5.0 Safari/605', ip, botIpRanges: ranges }) === 'bot';

  it('matches a bare address as a /32 and honors the prefix width', () => {
    expect(isBot('10.0.0.7', ['10.0.0.7'])).toBe(true);
    expect(isBot('10.0.0.8', ['10.0.0.7'])).toBe(false);
    expect(isBot('10.0.0.8', ['10.0.0.0/24'])).toBe(true);
    expect(isBot('10.0.1.8', ['10.0.0.0/24'])).toBe(false);
    expect(isBot('10.0.1.8', ['10.0.0.0/16'])).toBe(true);
  });

  it('matches every address for /0 and the boundaries above 2^31', () => {
    expect(isBot('203.0.113.1', ['0.0.0.0/0'])).toBe(true);
    expect(isBot('255.255.255.255', ['255.255.255.255'])).toBe(true);
    expect(isBot('200.0.0.1', ['128.0.0.0/1'])).toBe(true);
    expect(isBot('127.255.255.255', ['128.0.0.0/1'])).toBe(false);
  });

  it('tolerates surrounding whitespace and scans every range given', () => {
    expect(isBot(' 10.0.0.8 ', [' 10.0.0.0/24 '])).toBe(true);
    expect(isBot('10.0.0.8', ['bad', '192.168.0.0/16', '10.0.0.0/24'])).toBe(true);
  });

  it('is false for missing input rather than throwing', () => {
    expect(isBot(undefined, ['10.0.0.0/8'])).toBe(false);
    expect(isBot('10.0.0.1', undefined)).toBe(false);
    expect(isBot('10.0.0.1', [])).toBe(false);
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
