import { describe, it, expect } from 'vitest';
import { isHealthProbePath } from '../src/tracing.js';

describe('isHealthProbePath', () => {
  it('matches the estate health endpoints, query included', () => {
    expect(isHealthProbePath('/health')).toBe(true);
    expect(isHealthProbePath('/api/health')).toBe(true);
    expect(isHealthProbePath('/status')).toBe(true);
    expect(isHealthProbePath('/health?probe=1')).toBe(true);
  });

  it('keeps real routes', () => {
    expect(isHealthProbePath('/api/memories')).toBe(false);
    expect(isHealthProbePath('/healthz-lookalike')).toBe(false);
    expect(isHealthProbePath(undefined)).toBe(false);
  });
});
