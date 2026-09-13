import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * stdout is the JSON-RPC channel of a stdio MCP server. One line on it corrupts the
 * stream, and the client drops the connection with a parse error that names no
 * culprit - `server-memory` and `cli` both shipped a `process.stdout.write` diversion
 * around the bootstrap import to work around exactly that (the tracer's ready banner,
 * printed only when an OTLP endpoint is set, which is production and nowhere else).
 *
 * So: nothing in this package writes to stdout, ever. `console.warn`/`console.error`
 * are stderr in Node and stay allowed; `console.info`/`console.debug` are NOT - they
 * are stdout, which is how `DiagConsoleLogger` would have leaked at OTEL_LOG_LEVEL=info.
 *
 * A source-text test, like the edge-safety one: the runtime path is only taken with a
 * collector configured, so a behavioural test would pass on a developer's machine.
 */
const SRC = fileURLToPath(new URL('../../src', import.meta.url));

const STDOUT_WRITERS = [
  'console.log',
  'console.info',
  'console.debug',
  'console.dir',
  'console.table',
  'console.count',
  'console.group',
  'console.time',
  'process.stdout',
  'DiagConsoleLogger',
];

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });

describe('nothing in src writes to stdout', () => {
  // Comments included: the source-text rule is the point, and a commented-out
  // console.log is one paste away from being live again.
  const files = sources(SRC);

  it('scans every source file', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  for (const file of files) {
    it(`${file.slice(SRC.length + 1)} is stdout-free`, () => {
      const text = readFileSync(file, 'utf8');
      expect(STDOUT_WRITERS.filter((name) => text.includes(name))).toEqual([]);
    });
  }
});
