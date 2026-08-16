import { defineConfig } from 'tsdown'

export default defineConfig({
  outDir: 'lib',
  entry: [
    'src/index.ts',
    'src/command.ts',
    'src/tool.ts',
    'src/core.ts',
  ],
  format: ['esm'],
  dts: true,
  sourcemap: false,
  clean: true,
  external: [/^@deepseek-ai\//, /^node:/],
})
