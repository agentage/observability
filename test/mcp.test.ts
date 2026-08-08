import { describe, it, expect, vi, afterEach } from 'vitest';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { setMcpTool, markSpanError } from '../src/mcp.js';
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
