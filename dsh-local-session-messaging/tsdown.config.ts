import { defineConfig } from 'tsdown'

export default defineConfig({
  outDir: 'lib',
  entry: [
    'src/service.ts',
    'src/local.ts',
    'src/tool.ts',
    'src/command.ts',
    'src/prompt.ts',
    'src/core.ts',
  ],
  format: ['esm'],
  dts: true,
  sourcemap: false,
  clean: true,
  external: [/^@deepseek-ai\//, /^node:/],
})
