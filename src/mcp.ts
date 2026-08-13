import { trace, SpanStatusCode, type Attributes } from '@opentelemetry/api';
import type { Logger } from 'pino';
import { captureError } from './errors.js';
import { redactArgs, errorCodeOf, fingerprintOf } from './error-event.js';

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

/**
 * Merge attributes onto the ACTIVE span mid-request - the post-result half of
 * MCP enrichment (results count, payload bytes, error code) where the values
 * only exist after the handler ran. No-op without a started SDK.
 */
export function setSpanAttributes(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}

/** The MCP tool result shape, narrowed to what error reporting reads. */
export interface ToolResult {
  isError?: boolean;
  content?: { type?: string; text?: string }[];
}

export type ToolHandler<A, R extends ToolResult> = (args: A, ...rest: unknown[]) => R | Promise<R>;

const errorText = (result: ToolResult): string =>
  result.content?.find((part) => typeof part.text === 'string')?.text || 'tool returned isError';

export interface WrapToolOptions {
  /** Off by default - MCP tools answer expected refusals as isError, and those are not errors. */
  captureIsError?: boolean;
}

/**
 * Wrap an MCP tool handler so a thrown error emits the standard `ErrorEvent`.
 * Set `captureIsError` to also capture `isError` results, which travel over
 * HTTP 200 and are otherwise invisible. Arguments are logged redacted.
 */
export function wrapToolHandler<A, R extends ToolResult>(
  log: Logger,
  toolName: string,
  handler: ToolHandler<A, R>,
  options: WrapToolOptions = {}
): (args: A, ...rest: unknown[]) => Promise<R> {
  return async (args, ...rest) => {
    const ctx = { route: toolName, source: 'tool' as const, args: redactArgs(args) };
    try {
      const result = await handler(args, ...rest);
      if (result?.isError && options.captureIsError) {
        const err = new Error(errorText(result));
        markSpanError(err.message);
        captureError(log, err, { ...ctx, error_code: errorCodeOf(err) });
      }
      return result;
    } catch (err) {
      captureError(log, err, {
        ...ctx,
        error_code: errorCodeOf(err),
        fingerprint: fingerprintOf(err),
      });
      throw err;
    }
  };
}
