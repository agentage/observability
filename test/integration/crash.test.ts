import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installCrashCapture, type CrashProcess } from '../../src/internal/patch/crash.js';

const lines: Record<string, unknown>[] = [];

beforeEach(() => {
  lines.length = 0;
  vi.stubEnv('OTEL_SERVICE_NAME', 'crash-test');
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    for (const raw of String(chunk).split('\n')) {
      if (!raw) continue;
      try {
        lines.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // Not one of ours.
      }
    }
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

interface FakeProcess extends CrashProcess {
  emit(event: string, err: unknown): void;
  exit: ReturnType<typeof exitSpy>;
}

const exitSpy = () => vi.fn((_code: number): unknown => undefined);

const fakeProcess = (extraListeners: string[] = []): FakeProcess => {
  const listeners = new Map<string, ((err: unknown) => void)[]>();
  for (const event of extraListeners) listeners.set(event, [() => {}]);
  return {
    on(event: string, listener: (err: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return this;
    },
    listenerCount: (event: string) => listeners.get(event)?.length ?? 0,
    exit: exitSpy(),
    emit(event: string, err: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(err);
    },
  };
};

// The exit is queued behind the span flush.
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('installCrashCapture', () => {
  it.each(['uncaughtException', 'unhandledRejection'])(
    'logs %s as fatal and exits 1',
    async (event) => {
      const proc = fakeProcess();
      expect(installCrashCapture({ process: proc, env: {} })).toBe(true);
      proc.emit(event, new Error('the end'));
      const [line] = lines;
      expect(line.level).toBe(60);
      expect(line.kind).toBe(event);
      expect(line.msg).toBe('the end');
      expect(line.source).toBe('server');
      await settle();
      expect(proc.exit).toHaveBeenCalledWith(1);
    }
  );

  it('logs a non-Error rejection reason too', async () => {
    const proc = fakeProcess();
    installCrashCapture({ process: proc, env: {} });
    proc.emit('unhandledRejection', 'plain reason');
    expect(lines[0]?.msg).toBe('plain reason');
  });

  it('leaves the exit to a handler the service installed itself', async () => {
    const proc = fakeProcess(['uncaughtException']);
    installCrashCapture({ process: proc, env: {} });
    proc.emit('uncaughtException', new Error('handled elsewhere'));
    await settle();
    expect(lines).toHaveLength(1);
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it('installs once per process', () => {
    const proc = fakeProcess();
    expect(installCrashCapture({ process: proc, env: {} })).toBe(true);
    expect(installCrashCapture({ process: proc, env: {} })).toBe(false);
    expect(proc.listenerCount('uncaughtException')).toBe(1);
  });

  it('installs nothing when OBS_CRASH_CAPTURE is off', () => {
    const proc = fakeProcess();
    expect(installCrashCapture({ process: proc, env: { OBS_CRASH_CAPTURE: 'off' } })).toBe(false);
    expect(proc.listenerCount('uncaughtException')).toBe(0);
  });
});
