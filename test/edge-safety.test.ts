import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `health.ts` is re-exported from the `@agentage/shared` barrel in several repos, and
 * those barrels are imported by `middleware.ts`, which runs in the **Edge Runtime**.
 *
 * Next detects Node APIs in an edge bundle **statically**, at build or module
 * evaluation - not when the line runs. So a `typeof process?.uptime === 'function'`
 * guard is worthless: the mere presence of the identifier throws
 *
 *   Error: A Node.js API is used (process.uptime) which is not supported in the Edge Runtime.
 *
 * at module evaluation, which fails the gate before any page renders. On 2026-08-10
 * that 500'd every authenticated route on admin.agentage.io, in an app that only ever
 * wanted `links` from the barrel.
 *
 * So this is a SOURCE-TEXT test, deliberately. A behavioural test cannot catch it -
 * the code works perfectly under Node. The only thing that fails is a bundler reading
 * the source, so that is what this reproduces.
 */

// Raw text, comments INCLUDED. tsc emits comments into dist, and while Next parses an
// AST, not every analyzer that might read this package does - so the forbidden names
// must not appear at all, even in prose explaining why they are forbidden. The first
// run of this test caught exactly that: the comment documenting the fix.
const SOURCE = readFileSync(fileURLToPath(new URL('../src/health.ts', import.meta.url)), 'utf8');

// `process.env` is deliberately absent: Next supports it in edge bundles (it inlines
// them), and the envelope's whole provenance story is built on it.
const NODE_ONLY = [
  'process.uptime',
  'process.cwd',
  'process.hrtime',
  'process.memoryUsage',
  'process.versions',
  'process.platform',
  'process.exit',
  'process.nextTick',
  'require(',
  "from 'node:",
  'from "node:',
];

describe('health.ts stays edge-safe', () => {
  it.each(NODE_ONLY)('does not reference %s', (api) => {
    expect(SOURCE).not.toContain(api);
  });

  it('has no imports at all - every symbol comes from a cross-runtime global', () => {
    const imports = SOURCE.match(/^\s*import\s+(?!type\b)/gm) ?? [];
    expect(imports).toEqual([]);
  });

  it('reads the process start from performance.timeOrigin, a Web API', () => {
    expect(SOURCE).toContain('performance.timeOrigin');
  });

  it('ships a dist free of them too, when one has been built', async () => {
    const dist = new URL('../dist/health.js', import.meta.url);
    let built: string;
    try {
      built = readFileSync(fileURLToPath(dist), 'utf8');
    } catch {
      return; // test runs before build in `npm run verify`; the source scan above is the gate
    }
    for (const api of NODE_ONLY) expect(built).not.toContain(api);
  });

  it('still reports a plausible process start after the swap', async () => {
    const { healthEnvelope } = await import('../src/health.js');
    const { startedAt, uptimeSeconds } = healthEnvelope('edge-check').data;
    const drift = Math.abs(Date.parse(startedAt) - (Date.now() - process.uptime() * 1000));
    expect(drift).toBeLessThan(1000);
    expect(uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
