import { describe, it, expect, vi, afterEach } from 'vitest';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { setMcpTool, markSpanError, wrapToolHandler } from '../src/mcp.js';
import { createLogger } from '../src/logger.js';
import { FetchSpanNameProcessor } from '../src/span-names.js';
import type { Span } from '@opentelemetry/sdk-trace-base';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('setMcpTool / markSpanError', () => {
  it('stamps tool + extra attributes on the active span', () => {
    const setAttribute = vi.fn();
    const setAttributes = vi.fn();
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue({ setAttribute, setAttributes } as never);
    setMcpTool('memory__search', { 'mcp.surface': 'mcp' });
    expect(setAttribute).toHaveBeenCalledWith('mcp.tool.name', 'memory__search');
    expect(setAttributes).toHaveBeenCalledWith({ 'mcp.surface': 'mcp' });
  });

  it('marks the active span as error', () => {
    const setStatus = vi.fn();
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue({ setStatus } as never);
    markSpanError('NotFound');
    expect(setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'NotFound' });
  });

  it('is a no-op without an active span', () => {
    expect(() => setMcpTool('memory__read')).not.toThrow();
    expect(() => markSpanError()).not.toThrow();
  });
});

describe('MCP root rename at export', () => {
  it('renames SERVER spans carrying mcp.tool.name to the bare tool name', () => {
    const p = new FetchSpanNameProcessor();
    const span = {
      name: 'POST /mcp',
      kind: SpanKind.SERVER,
      attributes: { 'mcp.tool.name': 'memory__search' },
    } as unknown as Span;
    p.onEnd(span);
    expect((span as unknown as { name: string }).name).toBe('memory__search');
  });

  it('leaves protocol requests and non-server spans alone', () => {
    const p = new FetchSpanNameProcessor();
    const plain = { name: 'POST /mcp', kind: SpanKind.SERVER, attributes: {} } as unknown as Span;
    p.onEnd(plain);
    expect((plain as unknown as { name: string }).name).toBe('POST /mcp');
    const internal = {
      name: 'x',
      kind: SpanKind.INTERNAL,
      attributes: { 'mcp.tool.name': 'memory__search' },
    } as unknown as Span;
    p.onEnd(internal);
    expect((internal as unknown as { name: string }).name).toBe('x');
  });
});

describe('setSpanAttributes', () => {
  it('merges attributes onto the active span and no-ops without one', async () => {
    const { setSpanAttributes } = await import('../src/mcp.js');
    const setAttributes = vi.fn();
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue({ setAttributes } as never);
    setSpanAttributes({ 'mcp.results.count': 7 });
    expect(setAttributes).toHaveBeenCalledWith({ 'mcp.results.count': 7 });
    vi.restoreAllMocks();
    expect(() => setSpanAttributes({ x: 1 })).not.toThrow();
  });
});

function capture(): { lines: () => Record<string, unknown>[]; write: (msg: string) => void } {
  const raw: string[] = [];
  return {
    lines: () =>
      raw.flatMap((chunk) => chunk.split('\n').filter(Boolean)).map((l) => JSON.parse(l)),
    write: (msg: string) => {
      raw.push(msg);
    },
  };
}

describe('wrapToolHandler', () => {
  it('stays quiet on success', async () => {
    const out = capture();
    const log = createLogger({ service: 'memory-mcp', destination: out });
    const wrapped = wrapToolHandler(log, 'memory__read', async () => ({ content: [] }));
    await expect(wrapped({ path: 'a.md' })).resolves.toEqual({ content: [] });
    expect(out.lines()).toHaveLength(0);
  });

  it('emits the tool event on a throw and rethrows', async () => {
    const out = capture();
    const log = createLogger({ service: 'memory-mcp', destination: out });
    const err = Object.assign(new Error('store down'), { code: 'E_STORE', fingerprint: 'fp' });
    const wrapped = wrapToolHandler(log, 'memory__write', async () => {
      throw err;
    });
    await expect(wrapped({ path: 'a.md', token: 'sekret' })).rejects.toThrow('store down');
    const [line] = out.lines();
    expect(line.route).toBe('memory__write');
    expect(line.source).toBe('tool');
    expect(line.error_code).toBe('E_STORE');
    expect(line.fingerprint).toBe('fp');
    expect(line.args).toEqual({ path: 'a.md', token: '[redacted]' });
  });

  it('emits on an isError result and marks the span', async () => {
    const setStatus = vi.fn();
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue({
      setStatus,
      recordException: vi.fn(),
      spanContext: () => ({ traceId: '', spanId: '', traceFlags: 0 }),
    } as never);
    const out = capture();
    const log = createLogger({ service: 'memory-mcp', destination: out });
    const wrapped = wrapToolHandler(log, 'memory__search', async () => ({
      isError: true,
      content: [{ type: 'text', text: 'not found' }],
    }));
    const result = await wrapped({ query: 'x' });
    expect(result.isError).toBe(true);
    const [line] = out.lines();
    expect(line.msg).toBe('not found');
    expect(line.route).toBe('memory__search');
    expect(line.source).toBe('tool');
    expect(line.error_code).toBe('Error');
    expect(setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'not found' });
  });

  it('defaults the message when an isError result carries no text', async () => {
    const out = capture();
    const log = createLogger({ service: 'memory-mcp', destination: out });
    const wrapped = wrapToolHandler(log, 'memory__list', async () => ({ isError: true }));
    await wrapped({});
    expect(out.lines()[0].msg).toBe('tool returned isError');
  });
});
