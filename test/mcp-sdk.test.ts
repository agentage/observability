import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Protocol } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { z } from 'zod';
import { patchMcpServerModule, patchProtocolModule } from '../src/internal/patch/mcp.js';
import { useAsyncContextManager } from './stack-context-manager.js';

/**
 * The real SDK, patched exactly as the module hook patches it in a booted
 * service - both surfaces at once, which is how a live `McpServer` runs: the
 * tools/call request handler dispatches into the registered callback.
 */
patchProtocolModule({ Protocol });
patchMcpServerModule({ McpServer });

const lines: Record<string, unknown>[] = [];
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

const toolLines = (): Record<string, unknown>[] => lines.filter((line) => line.kind === 'tool');
const errorLines = (): Record<string, unknown>[] =>
  lines.filter((line) => line.source === 'tool' && line.err !== undefined);
const spans = (): ReadableSpan[] => exporter.getFinishedSpans();

beforeEach(() => {
  lines.length = 0;
  exporter.reset();
  useAsyncContextManager();
  trace.setGlobalTracerProvider(provider);
  vi.stubEnv('OTEL_SERVICE_NAME', 'mcp-sdk-test');
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

const connected = async (build: (server: McpServer) => void): Promise<Client> => {
  const server = new McpServer({ name: 'observability-test', version: '0.0.0' });
  build(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'observability-test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
};

describe('@modelcontextprotocol/sdk, in process', () => {
  it('instruments a registered tool end to end, once', async () => {
    const client = await connected((server) => {
      server.registerTool(
        'memory__write',
        { inputSchema: { path: z.string(), body: z.string() } },
        async ({ path }) => ({ content: [{ type: 'text' as const, text: `wrote ${path}` }] })
      );
    });

    const result = await client.callTool({
      name: 'memory__write',
      arguments: { path: 'notes/private.md', body: 'hello' },
    });

    expect(result.isError).toBeFalsy();
    expect(toolLines()).toHaveLength(1);
    expect(toolLines()[0].tool).toBe('memory__write');
    expect(toolLines()[0].status).toBe('ok');

    const toolSpan = spans().find((span) => span.name === 'memory__write');
    expect(toolSpan).toBeDefined();
    const args = JSON.parse(
      String((toolSpan?.attributes as Record<string, unknown>)['mcp.tool.args'])
    ) as Record<string, unknown>;
    expect(args).toEqual({ path: '<16 chars>', body: '<5 chars>' });
  });

  it('raises the ErrorEvent for a thrown tool, which the SDK answers as isError', async () => {
    const client = await connected((server) => {
      server.registerTool('memory__read', { inputSchema: { path: z.string() } }, async () => {
        throw new Error('no such memory');
      });
    });

    const result = await client.callTool({ name: 'memory__read', arguments: { path: 'gone.md' } });

    expect(result.isError).toBe(true);
    expect(errorLines()).toHaveLength(1);
    expect(errorLines()[0].route).toBe('memory__read');
    expect(toolLines()).toHaveLength(1);
    expect(toolLines()[0].status).toBe('error');
  });
});
