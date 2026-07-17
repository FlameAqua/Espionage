import { defineConfig } from 'vitest/config'

// Unit tests cover the pure logic (graph model, health check, undo history,
// report normalisation, redaction). They run in a plain Node environment — no
// Electron, no DOM, no live 3CX — so they're fast and CI-friendly.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false
  }
})
