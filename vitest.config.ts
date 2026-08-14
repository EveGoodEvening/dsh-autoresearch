import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    execArgv: ['--expose-internals'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
})
