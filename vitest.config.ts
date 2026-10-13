import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    execArgv: ['--expose-internals'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['**/*.d.ts', '**/*.generated.ts', '**/generated/**'],
      thresholds: {
        'src/agent.ts': {
          statements: 86,
          branches: 78,
          functions: 85,
          lines: 95,
        },
        'src/controller.ts': {
          statements: 83,
          branches: 65,
          functions: 91,
          lines: 92,
        },
        'src/git.ts': {
          statements: 88,
          branches: 76,
          functions: 96,
          lines: 97,
        },
        'src/index.ts': {
          statements: 84,
          branches: 75,
          functions: 62,
          lines: 93,
        },
        'src/recovery.ts': {
          statements: 79,
          branches: 71,
          functions: 91,
          lines: 91,
        },
      },
    },
  },
})
