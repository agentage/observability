import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    tsconfigRaw: { compilerOptions: { target: 'es2022', useDefineForClassFields: true } },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      // Runtime-integration modules: covered by smoke:dist + the --import smoke,
      // not unit-testable without starting the NodeSDK.
      exclude: ['src/tracing.ts', 'src/bootstrap.ts', 'dist/**', '*.config.ts'],
      thresholds: { branches: 70, functions: 70, lines: 70, statements: 70 },
    },
  },
});
