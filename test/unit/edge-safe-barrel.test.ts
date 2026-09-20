import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';

// Next bundles instrumentation.ts for the edge runtime, where only a few node: builtins
// exist. Anything the root barrel reaches must therefore load without the rest of them.
const EDGE_BUILTINS = new Set(['node:async_hooks', 'node:events']);
const SRC = join(__dirname, '..', '..', 'src');

const staticImports = (file: string): string[] =>
  [
    ...readFileSync(file, 'utf8').matchAll(
      /^(?:import|export)\s+(?!type\s)[^'"]*from\s+['"]([^'"]+)['"]/gm
    ),
  ].map((m) => m[1]);

const reachable = (entry: string): Map<string, string[]> => {
  const seen = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    const specs = staticImports(file);
    seen.set(file, specs);
    for (const spec of specs) {
      if (spec.startsWith('.'))
        queue.push(normalize(join(dirname(file), spec.replace(/\.js$/, '.ts'))));
    }
  }
  return seen;
};

describe('root barrel is edge-safe', () => {
  it('reaches no node: builtin the Next edge runtime lacks', () => {
    const offenders: string[] = [];
    for (const [file, specs] of reachable(join(SRC, 'index.ts'))) {
      for (const spec of specs) {
        if (spec.startsWith('node:') && !EDGE_BUILTINS.has(spec))
          offenders.push(`${file} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
