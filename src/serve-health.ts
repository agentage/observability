import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { healthResponse, type ChecksInput, type HealthSourceOptions } from './health.js';

/** The two paths the estate probes: the container HEALTHCHECK and the edge-routed one. */
const DEFAULT_PATHS = ['/health', '/api/health'] as const;

const NOT_FOUND = JSON.stringify({ success: false, error: { code: 'NotFound' } });

export interface ServeHealthOptions extends Omit<HealthSourceOptions, 'checks'> {
  /** Paths answered; defaults to `/health` and `/api/health`. */
  paths?: readonly string[];
  /**
   * Bind address. Defaults to every interface: the container HEALTHCHECK probes
   * 127.0.0.1 while the admin console reaches the same port over the overlay.
   */
  host?: string;
}

export interface HealthServer {
  /** Resolves with the bound port once listening, so `serveHealth(0)` is testable. */
  readonly listening: Promise<number>;
  /** The underlying server, for a probe that needs the address itself. */
  readonly server: Server;
  close(): Promise<void>;
}

const pathOf = (url: string | undefined): string => (url ?? '/').split('?')[0].replace(/\/+$/, '');

const send = (res: ServerResponse, response: Response, body: string, head: boolean): void => {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(head ? undefined : body);
};

/**
 * The `/health` endpoint for a worker that has no HTTP server of its own - a
 * crawler, a queue consumer, a cron container. Answers `GET`/`HEAD` on
 * `/health` and `/api/health` with the same envelope every other service
 * returns, 503 when a non-optional check is down, and 404 everywhere else.
 * Node-only (`node:http`); the edge-safe machinery stays in `/health`.
 */
export function serveHealth(
  port: number,
  checks?: ChecksInput,
  options: ServeHealthOptions = {}
): HealthServer {
  const paths = (options.paths ?? DEFAULT_PATHS).map((path) => path.replace(/\/+$/, ''));
  const { paths: _paths, host, ...source } = options;
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase();
    if ((method !== 'GET' && method !== 'HEAD') || !paths.includes(pathOf(req.url))) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(method === 'HEAD' ? undefined : NOT_FOUND);
      return;
    }
    const response = await healthResponse({ ...source, checks });
    send(res, response, await response.text(), method === 'HEAD');
  };

  const server = createServer((req, res) => {
    // A throwing check must answer 500, not kill the worker it is reporting on.
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });

  const listening = new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });

  // An un-awaited listen failure (EADDRINUSE) must not crash the worker.
  listening.catch(() => undefined);

  return {
    listening,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        // Keep-alive sockets otherwise hold the close open past the shutdown budget.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
