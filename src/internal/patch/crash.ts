import { trace } from '@opentelemetry/api';
import { log } from '../../log.js';
import { toError } from '../error-fields.js';

/** Structural, so a test can install onto a stand-in instead of the real process. */
export interface CrashProcess {
  on(event: string, listener: (err: unknown) => void): unknown;
  listenerCount(event: string): number;
  exit(code: number): unknown;
}

export interface CrashCaptureOptions {
  env?: NodeJS.ProcessEnv;
  process?: CrashProcess;
}

const FLUSH_TIMEOUT_MS = 2000;

const INSTALLED = Symbol.for('agentage.observability.crash.installed');

interface Flushable {
  forceFlush?(): Promise<unknown>;
  getDelegate?(): unknown;
}

// The last spans of a dying process are the interesting ones, and the batch
// processor would otherwise be collected with everything else.
const flush = async (): Promise<void> => {
  const provider = trace.getTracerProvider() as Flushable;
  const target = (provider.getDelegate?.() ?? provider) as Flushable;
  if (typeof target.forceFlush !== 'function') return;
  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, FLUSH_TIMEOUT_MS).unref();
  });
  await Promise.race([
    target.forceFlush().then(
      () => undefined,
      () => undefined
    ),
    timeout,
  ]);
};

/**
 * The two ways a Node process dies without anyone logging it. Both handlers write
 * one `fatal` line - the crash's own `ErrorEvent`, with the trace it happened
 * under - then flush and exit 1, which is exactly what Node itself would have
 * done: installing a listener is what suppresses the default crash, so the exit
 * has to be re-stated. A handler the service installed itself owns the shutdown
 * instead, and then the kit only logs. `OBS_CRASH_CAPTURE=off` opts out.
 */
export function installCrashCapture(options: CrashCaptureOptions = {}): boolean {
  const env = options.env ?? process.env;
  if ((env.OBS_CRASH_CAPTURE ?? '').trim().toLowerCase() === 'off') return false;
  const proc = options.process ?? (process as unknown as CrashProcess);
  const host = proc as unknown as Record<symbol, unknown>;
  if (host[INSTALLED]) return false;
  host[INSTALLED] = true;

  const capture = (event: string) => (err: unknown) => {
    log.fatal({ err: toError(err), source: 'server', kind: event });
    // Another listener decides how this process dies; ours must not exit first.
    if (proc.listenerCount(event) > 1) return;
    void flush().then(() => proc.exit(1));
  };

  proc.on('uncaughtException', capture('uncaughtException'));
  proc.on('unhandledRejection', capture('unhandledRejection'));
  return true;
}
