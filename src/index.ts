// THE api: four names. `log` what happened, `span` what took time, `setUser`
// who it was for, `health` what the service reports about itself.
export { log, type Logger } from './log.js';
export { span } from './span.js';
export { setUser } from './user.js';
export { health } from './health.js';

// The shapes those lines travel in - the contract the estate reads.
export type {
  ClientErrorEvent,
  ErrorEvent,
  ErrorSource,
  SerializedError,
} from './internal/error-fields.js';

// deprecated, removed in the next major - migrate to log / span / setUser.
export { createLogger, type LoggerOptions } from './log.js';
export { withSpan } from './span.js';
export { tracedFetch } from './traced-fetch.js';
export {
  CLIENT_TYPE_HEADER,
  USER_TYPE_FIELD,
  UserType,
  classifyClientType,
  type ClientTypeInput,
} from './internal/classify.js';
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
} from './internal/patch/error-emitters.js';
export {
  collectorHandler,
  type CollectorHandler,
  type CollectorOptions,
  type CollectorRequest,
  type CollectorResponse,
} from './internal/patch/collector.js';
export {
  createRequestLog,
  type RequestLogMiddleware,
  type RequestLogOptions,
  type RequestLogRequest,
  type RequestLogResponse,
} from './internal/patch/request-log.js';
export {
  setMcpTool,
  markSpanError,
  setSpanAttributes,
  wrapToolHandler,
  type ToolHandler,
  type ToolResult,
  type WrapToolOptions,
} from './mcp.js';
