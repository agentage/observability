import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    tsconfigRaw: { compilerOptions: { target: 'es2022', useDefineForClassFields: true } },
  },
  test: {
    // contract/ = the shapes consumers read, integration/ = the wiring, unit/ = the rest.
    include: ['test/{contract,integration,unit}/**/*.test.ts'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      // Registers the ESM loader hook on import: covered by the --import smoke,
      // not reachable from a test process that has already loaded its modules.
      exclude: ['src/internal/patch/loader-hook.ts', 'dist/**', '*.config.ts'],
      thresholds: { branches: 70, functions: 70, lines: 70, statements: 70 },
    },
  },
});
