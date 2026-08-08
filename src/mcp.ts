import { trace, SpanStatusCode, type Attributes } from '@opentelemetry/api';

/**
 * Stamp the ACTIVE (root HTTP) span as an MCP tool call: the kit renames it to
 * the bare tool name at export, so operations group per tool. Call at the top
 * of the tool handler/dispatch. No-op without a started SDK.
 */
export function setMcpTool(tool: string, attributes?: Attributes): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttribute('mcp.tool.name', tool);
  if (attributes) span.setAttributes(attributes);
}

/**
 * Flag the active span as failed. MCP tool failures travel as isError RESULTS
 * over HTTP 200, which trace status never sees otherwise.
 */
export function markSpanError(message?: string): void {
  trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR, message });
}
