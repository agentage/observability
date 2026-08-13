export { resolveTracingConfig, type TracingConfig } from './config.js';
export { createLogger, logger, type Logger, type LoggerOptions } from './logger.js';
export { captureError } from './errors.js';
export {
  redactArgs,
  errorCodeOf,
  fingerprintOf,
  type ClientErrorEvent,
  type ErrorEvent,
  type ErrorEventContext,
  type ErrorSource,
  type SerializedError,
} from './error-event.js';
export {
  errorMiddleware,
  onRequestError,
  type ErrorMiddlewareOptions,
  type ErrorRequest,
  type ErrorResponse,
  type ExpressErrorHandler,
  type NextErrorContext,
  type NextErrorRequest,
  type NextRequestErrorHandler,
} from './error-emitters.js';
export {
  collectorHandler,
  parseClientEvents,
  type CollectorHandler,
  type CollectorOptions,
  type CollectorRequest,
  type CollectorResponse,
} from './collector.js';
export { routeFromUrl, normalizeFetchSpanName, FetchSpanNameProcessor } from './span-names.js';
export { NextNoiseSampler, samplerFromEnv } from './noise-sampler.js';
export { withSpan } from './with-span.js';
export {
  setMcpTool,
  markSpanError,
  setSpanAttributes,
  wrapToolHandler,
  type ToolHandler,
  type ToolResult,
  type WrapToolOptions,
} from './mcp.js';
