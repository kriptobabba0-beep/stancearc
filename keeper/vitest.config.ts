import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: [
        'src/**/*.ts',
      ],
      exclude: [
        'test/**',
        '**/*.d.ts',
        'src/index.ts', // entrypoint — side-effectful, not unit-testable in isolation
        'node_modules/**',
      ],
    },
  },
});
