import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './test/globalSetup.ts',
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/sinapse_test',
      RUN_SCHEDULER: 'false',
      JWT_SECRET: 'test-secret',
      OBJECT_STORAGE_DIR: '/tmp/sinapse-test-storage',
      SCIM_TOKEN: 'scim-test-token',
      ANTHROPIC_API_KEY: '',
    },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
