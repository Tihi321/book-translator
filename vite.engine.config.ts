import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Builds the headless engine to out/engine/index.js (CommonJS, runs with plain Node or in Electron's utilityProcess).
// Dependencies stay external (ssr build), so node_modules must be present next to the repo.
export default defineConfig({
  build: {
    ssr: resolve(__dirname, 'src/engine/index.ts'),
    outDir: 'out/engine',
    emptyOutDir: true,
    target: 'node24',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      output: { format: 'cjs', entryFileNames: 'index.js' }
    }
  },
  ssr: { target: 'node', noExternal: [] }
})
