export { createLogger, type Logger, type LoggerOptions } from './logger.js';
export {
  type ClientErrorEvent,
  type ErrorEvent,
  type ErrorSource,
  type SerializedError,
} from './error-event.js';
export {
  CLIENT_TYPE_HEADER,
  USER_TYPE_FIELD,
  UserType,
  classifyClientType,
  type ClientTypeInput,
} from './client-type.js';
export { tracedFetch } from './traced-fetch.js';
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
  type CollectorHandler,
  type CollectorOptions,
  type CollectorRequest,
  type CollectorResponse,
} from './collector.js';
export {
  createRequestLog,
  type RequestLogMiddleware,
  type RequestLogOptions,
  type RequestLogRequest,
  type RequestLogResponse,
} from './request-log.js';
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
