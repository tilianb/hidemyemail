import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['test/validate-release.test.mjs'] },
})
