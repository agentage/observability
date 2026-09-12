import { context as otelContext, trace, SpanKind } from '@opentelemetry/api';
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
} from '@opentelemetry/instrumentation';
import { log } from '../../log.js';
import { markSpanError, setMcpTool, setSpanAttributes } from '../../mcp.js';
import { USER_TYPE_FIELD } from '../classify.js';
import {
  enterUserScope,
  stampUserId,
  stampUserType,
  userIdFromContext,
  userTypeFromContext,
} from '../context.js';
import { errorCodeOf, fingerprintOf, redactArgs, toError } from '../error-fields.js';
import { claimToolCall, isToolWrapped, markToolWrapped, runClaimable } from '../tool-guard.js';
import { registerLoaderHook } from './loader-hook.js';

const TRACER = '@agentage/observability';

/** What the kit reads off a tool result; everything else passes through untouched. */
export interface ToolCallResult {
  isError?: boolean;
  content?: { type?: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

// Content-bearing keys carry the customer's own prose, so only a length marker
// reaches the exporter. `path` joined them (web#473): a note title is as
// revealing as the note. Everything else - query, folder, tags, limit, ids -
// stays verbatim, then goes through the standard secret/length redaction.
const CONTENT_KEYS = new Set(['body', 'content', 'text', 'old_str', 'new_str', 'path']);

const MAX_ARGS_ATTR_LEN = 2048;

/** Tool arguments with content fields marked and credentials redacted. */
export const redactToolArgs = (args: unknown): Record<string, unknown> | undefined => {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const marked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    marked[key] =
      CONTENT_KEYS.has(key) && typeof value === 'string' ? `<${value.length} chars>` : value;
  }
  return redactArgs(marked);
};

/** The same arguments as the bounded `mcp.tool.args` span attribute. */
export const toolArgsAttribute = (args: unknown): { json: string; truncated: boolean } => {
  const json = JSON.stringify(redactToolArgs(args) ?? {});
  return json.length > MAX_ARGS_ATTR_LEN
    ? { json: json.slice(0, MAX_ARGS_ATTR_LEN), truncated: true }
    : { json, truncated: false };
};

// Only structured content carries arrays (search results, list entries); a
// single-object result has no count, which is why undefined is a valid answer.
export const resultCount = (result: ToolCallResult): number | undefined => {
  const structured = result?.structuredContent;
  if (!structured) return undefined;
  for (const value of Object.values(structured)) {
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
};

export const responseBytes = (result: ToolCallResult): number =>
  (result?.content ?? []).reduce(
    (sum, part) => (typeof part?.text === 'string' ? sum + part.text.length : sum),
    0
  );

const errorText = (result: ToolCallResult): string =>
  result.content?.find((part) => typeof part.text === 'string')?.text || 'tool returned isError';

const isOn = (value: string | undefined): boolean => (value ?? '').trim().toLowerCase() === 'on';

const isOff = (value: string | undefined): boolean => (value ?? '').trim().toLowerCase() === 'off';

/**
 * One span per tool call. Under HTTP the request's root span IS the call, so it
 * is stamped (the kit renames it to the bare tool name at export); a stdio
 * server has no request span at all, so the call becomes the root itself. Either
 * way a user scope is open, so `setUser()` inside a tool handler has somewhere
 * to write.
 */
const withToolSpan = async <T>(tool: string, args: unknown, run: () => Promise<T>): Promise<T> => {
  const { json, truncated } = toolArgsAttribute(args);
  const attributes = {
    'mcp.tool.args': json,
    ...(truncated ? { 'mcp.tool.args_truncated': true } : {}),
  };
  const enter = (): Promise<T> => {
    const scope = enterUserScope();
    return otelContext.with(scope.context, run);
  };
  if (trace.getActiveSpan()) {
    setMcpTool(tool, attributes);
    return enter();
  }
  return trace
    .getTracer(TRACER)
    .startActiveSpan(tool, { kind: SpanKind.SERVER, attributes }, async (span) => {
      span.setAttribute('mcp.tool.name', tool);
      stampUserType(span);
      stampUserId(span);
      try {
        return await enter();
      } finally {
        span.end();
      }
    });
};

/**
 * The whole per-tool lane in one place: span, redacted arguments, result
 * metrics, error capture and the `kind:'tool'` wide event. `emit` is what keeps
 * a doubly-seen call to one event - the outer patch surface stays quiet when the
 * inner one already reported.
 */
const instrument = async <T>(
  tool: string,
  args: unknown,
  invoke: () => Promise<T>,
  shouldEmit: () => boolean = () => true
): Promise<T> =>
  withToolSpan(tool, args, async () => {
    const started = process.hrtime.bigint();
    let emit = true;
    let status: 'ok' | 'error' = 'ok';
    let errorCode: string | undefined;
    try {
      const result = await invoke();
      emit = shouldEmit();
      if (!emit) return result;
      const typed = result as ToolCallResult;
      const count = resultCount(typed);
      setSpanAttributes({
        ...(count === undefined ? {} : { 'mcp.results.count': count }),
        'mcp.response.bytes': responseBytes(typed),
      });
      // A tool-level failure travels as an isError RESULT over HTTP 200, which
      // no trace status sees - and is usually an expected refusal, so the span
      // is marked but no ErrorEvent is raised unless the service opts in.
      if (typed?.isError) {
        status = 'error';
        errorCode = 'tool_error';
        markSpanError(errorText(typed));
        setSpanAttributes({ 'error.code': errorCode });
        if (isOn(process.env.OBS_MCP_CAPTURE_ISERROR)) {
          log.error({
            err: new Error(errorText(typed)),
            route: tool,
            source: 'tool',
            args: redactToolArgs(args),
            user_id: userIdFromContext(),
            error_code: errorCode,
          });
        }
      }
      return result;
    } catch (err) {
      emit = shouldEmit();
      if (emit) {
        status = 'error';
        errorCode = errorCodeOf(err) ?? 'unknown';
        markSpanError(errorCode);
        setSpanAttributes({ 'error.code': errorCode });
        log.error({
          err: toError(err),
          route: tool,
          source: 'tool',
          args: redactToolArgs(args),
          user_id: userIdFromContext(),
          error_code: errorCode,
          fingerprint: fingerprintOf(err),
        });
      }
      throw err;
    } finally {
      if (emit) {
        const userType = userTypeFromContext();
        log.info(
          {
            kind: 'tool',
            tool,
            duration_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
            status,
            user_id: userIdFromContext(),
            ...(userType === undefined ? {} : { [USER_TYPE_FIELD]: userType }),
            ...(errorCode ? { error_code: errorCode } : {}),
          },
          'tool_call'
        );
      }
    }
  });

type ToolCallback = (this: unknown, ...args: unknown[]) => unknown;

/**
 * The registration-time half: the tool's own callback, where a thrown error is
 * still a throw. Already-wrapped callbacks are returned untouched.
 */
const wrapToolCallback = (tool: string, callback: unknown): unknown => {
  if (typeof callback !== 'function' || isToolWrapped(callback)) return callback;
  const original = callback as ToolCallback;
  const wrapped = async function (this: unknown, ...callArgs: unknown[]): Promise<unknown> {
    // A schema-less tool is called with `(extra)` alone, so arguments exist at arity 2.
    const args = callArgs.length >= 2 ? callArgs[0] : undefined;
    claimToolCall();
    return instrument(tool, args, async () => original.apply(this, callArgs));
  };
  return markToolWrapped(wrapped);
};

const PATCHED = Symbol.for('agentage.observability.mcp.patched');

const claimProto = (
  proto: Record<string, unknown> | undefined
): proto is Record<string, unknown> => {
  if (!proto || PATCHED in proto) return false;
  Object.defineProperty(proto, PATCHED, { value: true });
  return true;
};

/** Structural shapes of the SDK surfaces this patches - no SDK import. */
interface McpServerModule {
  McpServer?: { prototype?: Record<string, unknown> };
}

interface ProtocolModule {
  Protocol?: { prototype?: Record<string, unknown> };
}

/**
 * `McpServer.registerTool(name, config, cb)` and every `tool(...)` overload -
 * whose callback is always the last argument - get their handler wrapped once,
 * at registration.
 */
export function patchMcpServerModule<T>(moduleExports: T): T {
  const proto = (moduleExports as McpServerModule)?.McpServer?.prototype;
  if (!claimProto(proto)) return moduleExports;
  const registerTool = proto.registerTool;
  if (typeof registerTool === 'function') {
    const original = registerTool as ToolCallback;
    proto.registerTool = function (this: unknown, ...args: unknown[]): unknown {
      if (args.length >= 3) args[2] = wrapToolCallback(String(args[0]), args[2]);
      return original.apply(this, args);
    };
  }
  const tool = proto.tool;
  if (typeof tool === 'function') {
    const original = tool as ToolCallback;
    proto.tool = function (this: unknown, ...args: unknown[]): unknown {
      const last = args.length - 1;
      if (last >= 1) args[last] = wrapToolCallback(String(args[0]), args[last]);
      return original.apply(this, args);
    };
  }
  return moduleExports;
}

const CALL_TOOL_METHOD = 'tools/call';

// Structural across zod v3 (`shape` / `_def`) and v4 (`_zod.def`): the kit must
// not depend on the SDK's zod, and the method literal is the only thing read.
const methodLiteralOf = (schema: unknown): string | undefined => {
  try {
    const object = schema as {
      shape?: Record<string, unknown>;
      _zod?: { def?: { shape?: Record<string, unknown> } };
      _def?: { shape?: unknown };
    };
    const lazy = object?._def?.shape;
    const shape =
      object?.shape ??
      object?._zod?.def?.shape ??
      (typeof lazy === 'function'
        ? (lazy as () => Record<string, unknown>)()
        : (lazy as Record<string, unknown> | undefined));
    const method = shape?.method as
      | {
          value?: unknown;
          _def?: { value?: unknown; values?: unknown[] };
          _zod?: { def?: { value?: unknown; values?: unknown[] } };
        }
      | undefined;
    const def = method?._zod?.def ?? method?._def;
    const value =
      method?.value ?? def?.value ?? (Array.isArray(def?.values) ? def?.values[0] : undefined);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The dispatch-time half, for servers built on the low-level `Server`: the
 * tools/call request handler, where the tool name lives in the request params.
 */
const wrapCallToolHandler = (schema: unknown, handler: unknown): unknown => {
  if (typeof handler !== 'function' || isToolWrapped(handler)) return handler;
  if (methodLiteralOf(schema) !== CALL_TOOL_METHOD) return handler;
  const original = handler as ToolCallback;
  const wrapped = async function (this: unknown, ...callArgs: unknown[]): Promise<unknown> {
    const params = (callArgs[0] as { params?: { name?: unknown; arguments?: unknown } })?.params;
    const tool = typeof params?.name === 'string' ? params.name : 'unknown';
    return runClaimable((claim) =>
      instrument(
        tool,
        params?.arguments,
        async () => original.apply(this, callArgs),
        () => !claim.claimed
      )
    );
  };
  return markToolWrapped(wrapped);
};

/** `Protocol.setRequestHandler` is what both `Server` and `McpServer` register through. */
export function patchProtocolModule<T>(moduleExports: T): T {
  const proto = (moduleExports as ProtocolModule)?.Protocol?.prototype;
  if (!claimProto(proto)) return moduleExports;
  const setRequestHandler = proto.setRequestHandler;
  if (typeof setRequestHandler === 'function') {
    const original = setRequestHandler as ToolCallback;
    proto.setRequestHandler = function (this: unknown, ...args: unknown[]): unknown {
      if (args.length >= 2) args[1] = wrapCallToolHandler(args[0], args[1]);
      return original.apply(this, args);
    };
  }
  return moduleExports;
}

const SDK = '@modelcontextprotocol/sdk';

// `registerTool` landed in 1.11; the estate runs 1.29/1.30. Both build layouts
// are hooked because the same package serves ESM and CJS consumers.
const SUPPORTED = ['>=1.11 <2'];

const PATCH_VERSION = '1.0.0';

class McpToolInstrumentation extends InstrumentationBase {
  constructor() {
    super('@agentage/observability/mcp', PATCH_VERSION, {});
  }

  init(): InstrumentationNodeModuleDefinition[] {
    // Nothing to unpatch: the wrappers are installed for the life of the process.
    const noUnpatch = (): void => undefined;
    const file = (
      path: string,
      patch: (moduleExports: unknown) => unknown
    ): InstrumentationNodeModuleFile =>
      new InstrumentationNodeModuleFile(`${SDK}/${path}`, SUPPORTED, patch, noUnpatch);
    const mcpServer = (moduleExports: unknown): unknown => patchMcpServerModule(moduleExports);
    const protocol = (moduleExports: unknown): unknown => patchProtocolModule(moduleExports);
    return [
      new InstrumentationNodeModuleDefinition(SDK, SUPPORTED, undefined, undefined, [
        file('dist/esm/server/mcp.js', mcpServer),
        file('dist/cjs/server/mcp.js', mcpServer),
        file('dist/esm/shared/protocol.js', protocol),
        file('dist/cjs/shared/protocol.js', protocol),
      ]),
    ];
  }
}

let instrumentation: McpToolInstrumentation | undefined;

/**
 * Hook the MCP SDK's module load, so every tool an `McpServer` or a low-level
 * `Server` registers is instrumented with no code in the service. Rides the same
 * hook as the OpenTelemetry instrumentations, so a service that never installed
 * the SDK simply never triggers it. `OBS_MCP_PATCH=off` opts out.
 */
export function installMcpPatch(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isOff(env.OBS_MCP_PATCH) || instrumentation) return false;
  registerLoaderHook();
  instrumentation = new McpToolInstrumentation();
  instrumentation.enable();
  return true;
}
