import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    // Explicit include keeps Playwright e2e specs out of the Vitest run.
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    exclude: ['test/e2e/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      include: [
        'hooks/**/*.ts',
        'components/**/*.tsx',
        'lib/**/*.ts',
        'app/**/*.ts',
        'app/**/*.tsx',
      ],
      exclude: [
        'test/**',
        '**/*.d.ts',
        '**/generated/**',
        '**/abis/**',
        'node_modules/**',
      ],
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
