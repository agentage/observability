import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import {
  installMcpPatch,
  patchMcpServerModule,
  patchProtocolModule,
  redactToolArgs,
} from '../../src/internal/patch/mcp.js';
import { wrapToolHandler } from '../../src/mcp.js';
import { log } from '../../src/log.js';
import { useAsyncContextManager } from '../helpers/stack-context-manager.js';
import type { Logger } from 'pino';

type Handler = (...args: unknown[]) => unknown;

interface ToolResult {
  content?: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Fresh classes per test: a prototype is only ever patched once. */
const fakeMcpServerModule = () => {
  class McpServer {
    readonly tools = new Map<string, Handler>();
    registerTool(name: string, _config: unknown, cb: Handler): Handler {
      this.tools.set(name, cb);
      return cb;
    }
    tool(name: string, ...rest: unknown[]): void {
      this.tools.set(name, rest[rest.length - 1] as Handler);
    }
  }
  return { McpServer };
};

const fakeProtocolModule = () => {
  class Protocol {
    readonly handlers = new Map<string, Handler>();
    setRequestHandler(schema: { shape: { method: { value: string } } }, handler: Handler): void {
      this.handlers.set(schema.shape.method.value, handler);
    }
  }
  return { Protocol };
};

/** The zod v3 shape the SDK's request schemas carry. */
const schemaFor = (method: string) => ({ shape: { method: { value: method } } });

const callToolRequest = (name: string, args?: unknown) => ({
  method: 'tools/call',
  params: { name, arguments: args },
});

const textResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });

const lines: Record<string, unknown>[] = [];
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

const toolLines = (): Record<string, unknown>[] => lines.filter((line) => line.kind === 'tool');
const errorLines = (): Record<string, unknown>[] =>
  lines.filter((line) => line.source === 'tool' && line.err !== undefined);
const spans = (): ReadableSpan[] => exporter.getFinishedSpans();
const attributesOf = (index = 0): Record<string, unknown> =>
  spans()[index].attributes as Record<string, unknown>;

beforeEach(() => {
  lines.length = 0;
  exporter.reset();
  useAsyncContextManager();
  trace.setGlobalTracerProvider(provider);
  vi.stubEnv('OTEL_SERVICE_NAME', 'mcp-patch-test');
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    for (const raw of String(chunk).split('\n')) {
      if (!raw) continue;
      try {
        lines.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // Not one of ours; the stream carries other writers too.
      }
    }
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  trace.disable();
});

describe('registerTool patch', () => {
  it('names the span after the tool and emits one wide event', async () => {
    const mod = patchMcpServerModule(fakeMcpServerModule());
    const server = new mod.McpServer();
    server.registerTool('memory__search', {}, async () => ({
      content: [{ type: 'text', text: 'hit' }],
      structuredContent: { results: [1, 2, 3] },
    }));

    const result = (await server.tools.get('memory__search')?.(
      { query: 'needle' },
      {}
    )) as ToolResult;

    expect(result.structuredContent).toEqual({ results: [1, 2, 3] });
    expect(spans()).toHaveLength(1);
    expect(spans()[0].name).toBe('memory__search');
    expect(attributesOf()['mcp.tool.name']).toBe('memory__search');
    expect(attributesOf()['mcp.results.count']).toBe(3);
    expect(attributesOf()['mcp.response.bytes']).toBe(3);

    expect(toolLines()).toHaveLength(1);
    const [line] = toolLines();
    expect(line.tool).toBe('memory__search');
    expect(line.status).toBe('ok');
    expect(typeof line.duration_ms).toBe('number');
    expect(line.msg).toBe('tool_call');
  });

  it('redacts content-bearing arguments and keeps the rest', async () => {
    const mod = patchMcpServerModule(fakeMcpServerModule());
    const server = new mod.McpServer();
    server.registerTool('memory__write', {}, async () => textResult('ok'));

    await server.tools.get('memory__write')?.(
      { path: 'notes/secret-diagnosis.md', body: 'twelve chars', folder: 'notes', token: 'abc' },
      {}
    );

    const args = JSON.parse(String(attributesOf()['mcp.tool.args'])) as Record<string, unknown>;
    expect(args.body).toBe('<12 chars>');
    expect(args.path).toBe('<25 chars>');
    expect(args.folder).toBe('notes');
    expect(args.token).toBe('[redacted]');
  });

  it('stamps an existing root span instead of opening a second one', async () => {
    const mod = patchMcpServerModule(fakeMcpServerModule());
    const server = new mod.McpServer();
    server.registerTool('memory__read', {}, async () => textResult('body'));

    await provider
      .getTracer('test')
      .startActiveSpan('POST /mcp', async (root) => {
        await server.tools.get('memory__read')?.({ path: 'a.md' }, {});
        root.end();
      })
      .catch(() => undefined);

    expect(spans()).toHaveLength(1);
    expect(attributesOf()['mcp.tool.name']).toBe('memory__read');
  });

  it('passes a schema-less tool its single extra argument through', async () => {
    const mod = patchMcpServerModule(fakeMcpServerModule());
    const server = new mod.McpServer();
    const seen: unknown[] = [];
    server.tool('ping', async (...args: unknown[]) => {
      seen.push(...args);
      return textResult('pong');
    });

    await server.tools.get('ping')?.({ sessionId: 's1' });

    expect(seen).toEqual([{ sessionId: 's1' }]);
    expect(JSON.parse(String(attributesOf()['mcp.tool.args']))).toEqual({});
    expect(toolLines()).toHaveLength(1);
  });
});

describe('tool failures', () => {
  it('marks the span on an isError result without raising an ErrorEvent', async () => {
    const mod = patchMcpServerModule(fakeMcpServerModule());
    const server = new mod.McpServer();
    server.registerTool('memory__read', {}, async () => ({
      ...textResult('not found'),
      isError: true,
    }));

    await server.tools.get('memory__read')?.({ path: 'gone.md' }, {});

    expect(spans()[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(attributesOf()['error.code']).toBe('tool_error');
    expect(toolLines()[0].status).toBe('error');
    expect(toolLines()[0].error_code).toBe('tool_error');
    expect(errorLines()).toHaveLength(0);
  });

  it('captures isError as an ErrorEvent when the service opts in', async () => {
    vi.stubEnv('OBS_MCP_CAPTURE_ISERROR', 'on');
    const mod = patchMcpServerModule(fakeMcpServerModule());
    const server = new mod.McpServer();
    server.registerTool('memory__read', {}, async () => ({
      ...textResult('not found'),
      isError: true,
    }));

    await server.tools.get('memory__read')?.({ path: 'gone.md' }, {});

    expect(errorLines()).toHaveLength(1);
    expect(errorLines()[0].route).toBe('memory__read');
  });

  it('emits an ErrorEvent and rethrows when the handler throws', async () => {
    const mod = patchMcpServerModule(fakeMcpServerModule());
    const server = new mod.McpServer();
    server.registerTool('memory__write', {}, async () => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });

    await expect(
      server.tools.get('memory__write')?.({ path: 'a.md', body: 'x' }, {})
    ).rejects.toThrow('disk full');

    expect(errorLines()).toHaveLength(1);
    expect(errorLines()[0].source).toBe('tool');
    expect(errorLines()[0].error_code).toBe('ENOSPC');
    expect((errorLines()[0].args as Record<string, unknown>).body).toBe('<1 chars>');
    expect(toolLines()[0].status).toBe('error');
    expect(spans()[0].status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('setRequestHandler patch', () => {
  it('instruments a low-level tools/call handler from the request params', async () => {
    const mod = patchProtocolModule(fakeProtocolModule());
    const server = new mod.Protocol();
    server.setRequestHandler(schemaFor('tools/call'), async () => textResult('hi'));

    await server.handlers.get('tools/call')?.(callToolRequest('search', { query: 'x' }), {});

    expect(spans()[0].name).toBe('search');
    expect(toolLines()).toHaveLength(1);
    expect(toolLines()[0].tool).toBe('search');
  });

  it('leaves handlers for other methods alone', () => {
    const mod = patchProtocolModule(fakeProtocolModule());
    const server = new mod.Protocol();
    const handler = async (): Promise<ToolResult> => textResult('list');
    server.setRequestHandler(schemaFor('tools/list'), handler);

    expect(server.handlers.get('tools/list')).toBe(handler);
  });
});

describe('one wrap per call', () => {
  it('reports once when both surfaces see the same call', async () => {
    const protocol = patchProtocolModule(fakeProtocolModule());
    const mcp = patchMcpServerModule(fakeMcpServerModule());
    const server = new mcp.McpServer();
    const dispatcher = new protocol.Protocol();
    server.registerTool('memory__list', {}, async () => textResult('entries'));
    // What McpServer does internally: one tools/call handler dispatching to the callback.
    dispatcher.setRequestHandler(schemaFor('tools/call'), async (request: unknown) => {
      const params = (request as { params: { name: string; arguments: unknown } }).params;
      return server.tools.get(params.name)?.(params.arguments, {});
    });

    await dispatcher.handlers.get('tools/call')?.(
      callToolRequest('memory__list', { limit: 5 }),
      {}
    );

    expect(toolLines()).toHaveLength(1);
    expect(toolLines()[0].tool).toBe('memory__list');
  });

  it('never wraps a handler twice, however often the patch runs', async () => {
    const first = fakeMcpServerModule();
    patchMcpServerModule(first);
    patchMcpServerModule(first);
    const server = new first.McpServer();
    server.registerTool('memory__search', {}, async () => textResult('hit'));

    await server.tools.get('memory__search')?.({ query: 'x' }, {});

    expect(toolLines()).toHaveLength(1);
    expect(spans()).toHaveLength(1);
  });

  it('skips a handler the deprecated wrapToolHandler already wrapped', async () => {
    const mod = patchMcpServerModule(fakeMcpServerModule());
    const server = new mod.McpServer();
    const wrapped = wrapToolHandler(log as Logger, 'memory__write', async () => {
      throw new Error('boom');
    });
    server.registerTool('memory__write', {}, wrapped as Handler);

    expect(server.tools.get('memory__write')).toBe(wrapped);
    await expect(server.tools.get('memory__write')?.({ path: 'a.md' }, {})).rejects.toThrow('boom');
    expect(errorLines()).toHaveLength(1);
    expect(toolLines()).toHaveLength(0);
  });
});

describe('redactToolArgs', () => {
  it('answers undefined for non-object arguments', () => {
    expect(redactToolArgs(undefined)).toBeUndefined();
    expect(redactToolArgs('text')).toBeUndefined();
    expect(redactToolArgs([1, 2])).toBeUndefined();
  });
});

describe('installMcpPatch', () => {
  it('is off when OBS_MCP_PATCH=off', () => {
    expect(installMcpPatch({ OBS_MCP_PATCH: 'off' })).toBe(false);
  });
});
